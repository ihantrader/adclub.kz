import { Inject, Injectable, Logger } from "@nestjs/common";
import { auditActions, auditEntities } from "@adclub/contracts";
import {
  dueTimeEvent,
  initialSubscriptionState,
  purchaseLinkVerdict,
  subscriptionAccess,
  subscriptionTransition,
  type SubscriptionEvent,
  type SubscriptionEventKind,
  type SubscriptionState,
  type SubscriptionStatus,
  type TimeEventKind,
} from "@adclub/domain";
import { and, asc, eq, lt, ne, notInArray, or, sql } from "drizzle-orm";
import { afterCommit, DatabaseService, type DbExecutor } from "../../database";
import { JobQueue, type Sweeper } from "../../jobs";
import { AuditLog, type AuditActorRecord } from "../audit";
import { account } from "../identity";
import { AppSettings } from "../settings";
import { applyBillingEventsJob } from "./billing-jobs";
import { Plans } from "./plans.service";
import {
  billingEvent,
  subscription,
  type BillingEventOutcome,
  type BillingEventRow,
  type BillingEventSource,
  type SubscriptionProviderName,
  type SubscriptionRow,
} from "./schema";
import type { NormalizedProviderEvent } from "./subscription-provider";

const HOUR_MS = 3_600_000;
/** Events applied per transaction of one run. */
const EVENTS_PER_BATCH = 50;
/** A pending event older than this has lost its job: `billing.wake-events` puts it back. */
const WAKE_AFTER_SECONDS = 60;

function stateOf(row: SubscriptionRow): SubscriptionState {
  return {
    status: row.status,
    periodEnd: row.currentPeriodEnd,
    graceUntil: row.graceUntil,
    unconfirmedSince: row.unconfirmedSince,
  };
}

function eventOf(row: BillingEventRow): SubscriptionEvent {
  return {
    kind: row.kind,
    ...(row.payload.periodEnd && { periodEnd: new Date(row.payload.periodEnd) }),
    ...(row.payload.graceUntil && { graceUntil: new Date(row.payload.graceUntil) }),
  };
}

/** What the journal keeps of a subscription's state. */
function journalState(
  row: Pick<SubscriptionRow, "status" | "currentPeriodEnd" | "graceUntil" | "unconfirmedSince">,
) {
  return {
    status: row.status,
    periodEnd: row.currentPeriodEnd.toISOString(),
    graceUntil: row.graceUntil?.toISOString() ?? null,
    unconfirmedSince: row.unconfirmedSince?.toISOString() ?? null,
  };
}

type ChangedBy = "provider" | "operator" | "system";

function auditActor(changedBy: ChangedBy): AuditActorRecord {
  return changedBy === "operator" ? { role: "operator" } : { role: "system" };
}

interface Outcome {
  outcome: Exclude<BillingEventOutcome, "pending">;
  detail: string | null;
  subscriptionId: string | null;
  fromStatus: SubscriptionStatus | null;
  toStatus: SubscriptionStatus | null;
}

/**
 * The events of subscriptions (ARCHITECTURE 9.4.1, 4.72; TASK-040): the one
 * way a subscription's status changes.
 *
 * `receive` keeps a provider's event in `billing_event` — once per its id
 * at the provider (a duplicate is no new row and no job) — and puts the
 * purchase's job on the queue in the same transaction. The worker
 * (`applyPurchase`) applies the purchase's pending events in the order of
 * their own time, each through the one table of moves
 * (`subscriptionTransition`): an event older than the last one applied is
 * no effect (`stale`), a renewal that pays nothing new is no effect, and an
 * event of a purchase owned by another account is refused. A change is
 * written with its journal entry in one transaction; what every event did
 * stays on it. `SubscriptionExpiry` (below) applies time's events.
 */
@Injectable()
export class SubscriptionEvents {
  private readonly logger = new Logger("Billing");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(JobQueue) private readonly queue: JobQueue,
    @Inject(AuditLog) private readonly audit: AuditLog,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(Plans) private readonly plans: Plans,
  ) {}

  /** Keeps a provider's event and puts its purchase on the queue; a duplicate changes nothing. */
  async receive(
    provider: SubscriptionProviderName,
    event: NormalizedProviderEvent,
    source: Exclude<BillingEventSource, "system">,
  ): Promise<{ eventId: string; duplicate: boolean }> {
    return this.database.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(billingEvent)
        .values({
          provider,
          providerEventId: event.providerEventId,
          source,
          kind: event.kind,
          providerRef: event.providerRef,
          accountId: event.accountId,
          eventAt: event.eventAt,
          payload: {
            ...(event.periodEnd && { periodEnd: event.periodEnd.toISOString() }),
            ...(event.graceUntil && { graceUntil: event.graceUntil.toISOString() }),
            ...(event.platform && { platform: event.platform }),
          },
        })
        .onConflictDoNothing({ target: [billingEvent.provider, billingEvent.providerEventId] })
        .returning({ id: billingEvent.id });
      if (!inserted) {
        const [existing] = await tx
          .select({ id: billingEvent.id })
          .from(billingEvent)
          .where(
            and(
              eq(billingEvent.provider, provider),
              eq(billingEvent.providerEventId, event.providerEventId),
            ),
          );
        return { eventId: existing!.id, duplicate: true };
      }
      await this.enqueue(tx, provider, event.providerRef);
      return { eventId: inserted.id, duplicate: false };
    });
  }

  private async enqueue(tx: DbExecutor | undefined, provider: string, providerRef: string) {
    await this.queue.enqueue(
      applyBillingEventsJob,
      { provider, providerRef },
      { ...(tx && { tx }), singletonKey: `${provider}:${providerRef}` },
    );
  }

  /** `billing.apply-events`: every pending event of one purchase, oldest first. */
  async applyPurchase(provider: string, providerRef: string): Promise<number> {
    const toleranceMs = (await this.settings.get("store_lag_tolerance_hours")) * HOUR_MS;
    let applied = 0;
    for (;;) {
      const count = await this.database.db.transaction(async (tx) => {
        const pending = await tx
          .select()
          .from(billingEvent)
          .where(
            and(
              eq(billingEvent.provider, provider as SubscriptionProviderName),
              eq(billingEvent.providerRef, providerRef),
              eq(billingEvent.outcome, "pending"),
            ),
          )
          .orderBy(asc(billingEvent.eventAt), asc(billingEvent.receivedAt))
          .limit(EVENTS_PER_BATCH)
          .for("update");
        for (const row of pending) {
          const result = await this.applyOne(tx, row, toleranceMs);
          await tx
            .update(billingEvent)
            .set({ ...result, appliedAt: sql`now()` })
            .where(eq(billingEvent.id, row.id));
          afterCommit(() =>
            this.logger.log(
              `Subscription event applied event=${row.id} kind=${row.kind} outcome=${result.outcome}${result.detail ? ` detail=${result.detail}` : ""} subscription=${result.subscriptionId ?? "-"} ${result.fromStatus ?? "-"}->${result.toStatus ?? "-"}`,
            ),
          );
        }
        return pending.length;
      });
      applied += count;
      if (count < EVENTS_PER_BATCH) return applied;
    }
  }

  private async applyOne(
    tx: DbExecutor,
    row: BillingEventRow,
    toleranceMs: number,
  ): Promise<Outcome> {
    const now = new Date();
    const changedBy: ChangedBy = row.source === "operator" ? "operator" : "provider";
    const [current] = await tx
      .select()
      .from(subscription)
      .where(
        and(
          eq(subscription.provider, row.provider as SubscriptionProviderName),
          eq(subscription.providerRef, row.providerRef!),
        ),
      )
      .for("update");
    const refused = (detail: string, sub: SubscriptionRow | null = null): Outcome => ({
      outcome: "refused",
      detail,
      subscriptionId: sub?.id ?? null,
      fromStatus: sub?.status ?? null,
      toStatus: null,
    });
    const event = eventOf(row);

    if (!current) {
      const initial = initialSubscriptionState(event);
      if (!initial) return refused("no_subscription");
      if (!row.accountId) return refused("no_account");
      const room = await this.makeRoom(tx, row.accountId, null, now, toleranceMs, changedBy, row);
      if (room === "already_active") return refused("already_active");
      const plan = await this.plans.inEffect("user", row.eventAt, tx);
      const [created] = await tx
        .insert(subscription)
        .values({
          audience: "user",
          accountId: row.accountId,
          planId: plan?.id ?? null,
          provider: row.provider as SubscriptionProviderName,
          purchasePlatform: row.payload.platform ?? null,
          providerRef: row.providerRef!,
          status: initial.status,
          currentPeriodEnd: initial.periodEnd,
          lastProviderEventAt: row.eventAt,
        })
        .returning();
      await this.journal(tx, null, created!, changedBy, row.kind, row.id);
      return {
        outcome: "applied",
        detail: room === "replaced" ? "replaced_previous" : null,
        subscriptionId: created!.id,
        fromStatus: null,
        toStatus: created!.status,
      };
    }

    const verdict = purchaseLinkVerdict({
      purchaseOwner: current.accountId ?? current.supplierId,
      claimant: row.accountId ?? current.accountId ?? current.supplierId!,
      otherCurrent: null,
    });
    if (verdict.kind === "linked_to_another_account") {
      return refused("linked_to_another_account", current);
    }
    if (
      current.lastProviderEventAt &&
      row.eventAt.getTime() < current.lastProviderEventAt.getTime()
    ) {
      return {
        outcome: "no_effect",
        detail: "stale",
        subscriptionId: current.id,
        fromStatus: current.status,
        toStatus: current.status,
      };
    }
    const transition = subscriptionTransition(
      current.audience,
      stateOf(current),
      event,
      now,
      toleranceMs,
    );
    if (transition.kind === "not_applicable") {
      return refused("not_applicable", current);
    }
    if (transition.kind === "stay") {
      await tx
        .update(subscription)
        .set({ lastProviderEventAt: row.eventAt, updatedAt: sql`now()` })
        .where(eq(subscription.id, current.id));
      return {
        outcome: "no_effect",
        detail: "no_change",
        subscriptionId: current.id,
        fromStatus: current.status,
        toStatus: current.status,
      };
    }
    const next = transition.next;
    if (current.status === "expired" && next.status !== "expired" && current.accountId) {
      // A late word brings an ended subscription back: one current per account.
      const room = await this.makeRoom(
        tx,
        current.accountId,
        current.id,
        now,
        toleranceMs,
        changedBy,
        row,
      );
      if (room === "already_active") return refused("already_active", current);
    }
    const updated = await this.write(tx, current, next, { lastProviderEventAt: row.eventAt });
    await this.journal(tx, current, updated, changedBy, row.kind, row.id);
    return {
      outcome: "applied",
      detail: null,
      subscriptionId: current.id,
      fromStatus: current.status,
      toStatus: updated.status,
    };
  }

  /**
   * Room for a new current subscription of the account (one per account):
   * none in the way — `free`; one that still gives access — `already_active`
   * (refused); one that gives none — it ends (`replaced`).
   */
  private async makeRoom(
    tx: DbExecutor,
    accountId: string,
    exceptId: string | null,
    now: Date,
    toleranceMs: number,
    changedBy: ChangedBy,
    cause: BillingEventRow,
  ): Promise<"free" | "replaced" | "already_active"> {
    // One account's subscriptions are decided one at a time.
    await tx
      .select({ id: account.id })
      .from(account)
      .where(eq(account.id, accountId))
      .for("update");
    const [other] = await tx
      .select()
      .from(subscription)
      .where(
        and(
          eq(subscription.accountId, accountId),
          ne(subscription.status, "expired"),
          exceptId ? ne(subscription.id, exceptId) : undefined,
        ),
      )
      .for("update");
    const verdict = purchaseLinkVerdict({
      purchaseOwner: null,
      claimant: accountId,
      otherCurrent: other
        ? { grantsAccess: subscriptionAccess(stateOf(other), now, toleranceMs).granted }
        : null,
    });
    if (verdict.kind === "already_active") return "already_active";
    if (verdict.kind === "link_new" && verdict.replaces && other) {
      const ended = await this.write(
        tx,
        other,
        { ...stateOf(other), status: "expired", graceUntil: null, unconfirmedSince: null },
        {},
      );
      await this.journal(tx, other, ended, changedBy, cause.kind, cause.id, "replaced");
      return "replaced";
    }
    return "free";
  }

  private async write(
    tx: DbExecutor,
    row: SubscriptionRow,
    next: SubscriptionState,
    extra: { lastProviderEventAt?: Date },
  ): Promise<SubscriptionRow> {
    const [updated] = await tx
      .update(subscription)
      .set({
        status: next.status,
        currentPeriodEnd: next.periodEnd,
        graceUntil: next.graceUntil,
        unconfirmedSince: next.unconfirmedSince,
        ...extra,
        version: sql`${subscription.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(subscription.id, row.id))
      .returning();
    return updated!;
  }

  async journal(
    tx: DbExecutor,
    before: SubscriptionRow | null,
    after: SubscriptionRow,
    changedBy: ChangedBy,
    eventKind: SubscriptionEventKind,
    billingEventId: string,
    note?: string,
  ): Promise<void> {
    await this.audit.record(
      {
        action: auditActions.subscriptionChanged,
        actor: auditActor(changedBy),
        entityType: auditEntities.subscription,
        entityId: after.id,
        before: before ? journalState(before) : null,
        after: {
          ...journalState(after),
          changedBy,
          eventKind,
          billingEventId,
          provider: after.provider,
          accountId: after.accountId,
          supplierId: after.supplierId,
          ...(note && { note }),
        },
      },
      tx,
    );
  }

  /** `billing.wake-events`: purchases whose events have waited too long go on the queue again. */
  async wake(): Promise<number> {
    const rows = await this.database.db
      .selectDistinct({ provider: billingEvent.provider, providerRef: billingEvent.providerRef })
      .from(billingEvent)
      .where(
        and(
          eq(billingEvent.outcome, "pending"),
          lt(billingEvent.receivedAt, sql`now() - make_interval(secs => ${WAKE_AFTER_SECONDS})`),
        ),
      )
      .limit(500);
    for (const row of rows) {
      if (row.providerRef) await this.enqueue(undefined, row.provider, row.providerRef);
    }
    return rows.length;
  }
}

/** A subscription due for a time's event, and which. */
interface ExpiryContext {
  toleranceMs: number;
}

/**
 * Every minute (`billing.expire-subscriptions`): time's events of
 * subscriptions, through the same table of moves (`dueTimeEvent`,
 * `subscriptionTransition`) — a term passed without a word from the store
 * (`expired_unconfirmed`, access stays the tolerance), the tolerance passed
 * (`expired`), a cancelled term over, a grace or retries over. Each move is
 * kept in `billing_event` as an event of `system` (its id — the
 * subscription, the event and its moment: one move once) and in the journal.
 */
@Injectable()
export class SubscriptionExpiry implements Sweeper<ExpiryContext> {
  private readonly logger = new Logger("Billing");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(SubscriptionEvents) private readonly events: SubscriptionEvents,
  ) {}

  async prepare(): Promise<ExpiryContext> {
    return { toleranceMs: (await this.settings.get("store_lag_tolerance_hours")) * HOUR_MS };
  }

  async claim(
    tx: DbExecutor,
    context: ExpiryContext,
    batch: { limit: number; excludeIds: string[] },
  ): Promise<string[]> {
    const tolerance = sql`make_interval(secs => ${context.toleranceMs / 1000})`;
    const rows = await tx
      .select({ id: subscription.id })
      .from(subscription)
      .where(
        and(
          or(
            and(
              eq(subscription.audience, "user"),
              eq(subscription.status, "active"),
              sql`${subscription.currentPeriodEnd} <= now()`,
            ),
            and(
              eq(subscription.status, "cancelled"),
              sql`${subscription.currentPeriodEnd} <= now()`,
            ),
            and(
              or(eq(subscription.status, "grace"), eq(subscription.status, "past_due")),
              sql`${subscription.graceUntil} <= now()`,
            ),
            and(
              eq(subscription.status, "expired_unconfirmed"),
              sql`${subscription.unconfirmedSince} + ${tolerance} <= now()`,
            ),
          ),
          batch.excludeIds.length > 0 ? notInArray(subscription.id, batch.excludeIds) : undefined,
        ),
      )
      .orderBy(asc(subscription.currentPeriodEnd))
      .limit(batch.limit)
      .for("update", { skipLocked: true });
    return rows.map((row) => row.id);
  }

  async apply(tx: DbExecutor, context: ExpiryContext, id: string): Promise<void> {
    const [row] = await tx.select().from(subscription).where(eq(subscription.id, id)).for("update");
    if (!row) return;
    const now = new Date();
    const kind: TimeEventKind | null = dueTimeEvent(
      row.audience,
      stateOf(row),
      now,
      context.toleranceMs,
    );
    if (!kind) return;
    const transition = subscriptionTransition(
      row.audience,
      stateOf(row),
      { kind },
      now,
      context.toleranceMs,
    );
    if (transition.kind !== "move") return;
    const moment = momentOf(kind, row, context.toleranceMs);
    const [updated] = await tx
      .update(subscription)
      .set({
        status: transition.next.status,
        currentPeriodEnd: transition.next.periodEnd,
        graceUntil: transition.next.graceUntil,
        unconfirmedSince: transition.next.unconfirmedSince,
        version: sql`${subscription.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(subscription.id, row.id))
      .returning();
    const [kept] = await tx
      .insert(billingEvent)
      .values({
        provider: "system",
        providerEventId: `${row.id}:${kind}:${moment.toISOString()}`,
        source: "system",
        kind,
        accountId: row.accountId,
        supplierId: row.supplierId,
        subscriptionId: row.id,
        eventAt: moment,
        outcome: "applied",
        fromStatus: row.status,
        toStatus: updated!.status,
        appliedAt: sql`now()`,
      })
      .onConflictDoNothing({ target: [billingEvent.provider, billingEvent.providerEventId] })
      .returning({ id: billingEvent.id });
    await this.events.journal(tx, row, updated!, "system", kind, kept?.id ?? "-");
  }

  summary(result: { processed: number; failed: number }): void {
    if (result.processed > 0 || result.failed > 0) {
      this.logger.log(
        `Subscriptions moved by time processed=${String(result.processed)} failed=${String(result.failed)}`,
      );
    }
  }
}

/** The moment a time's event marks: the term's end, the grace's end, the tolerance's end. */
function momentOf(kind: TimeEventKind, row: SubscriptionRow, toleranceMs: number): Date {
  switch (kind) {
    case "period_lapsed":
      return row.currentPeriodEnd;
    case "grace_lapsed":
      return row.graceUntil ?? row.currentPeriodEnd;
    case "tolerance_lapsed":
      return new Date((row.unconfirmedSince ?? row.currentPeriodEnd).getTime() + toleranceMs);
  }
}
