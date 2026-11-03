import { Inject, Injectable } from "@nestjs/common";
import type {
  AdminSupplierBillingResponse,
  AdminUserSubscription,
  AdminUserSubscriptionResponse,
  MySubscription,
  MySubscriptionResponse,
  SubscriptionHistoryEntry,
  SupplierCharge,
  SupplierChargePage,
  SupplierSubscriptionResponse,
  SupplierSubscriptionSummary,
} from "@adclub/contracts";
import { nextDailyRun, pastDueNextRetry, subscriptionAccess } from "@adclub/domain";
import { and, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { ApiException } from "../../common/errors";
import { DatabaseService } from "../../database";
import { ClubAccess, type ClubAccessSources } from "../club-access";
import { account, supplier } from "../identity";
import { supplierCardRequired } from "../offers";
import { AppSettings } from "../settings";
import { termKey } from "./payment-charger";
import { PaymentMethods } from "./payment-methods";
import { Plans } from "./plans.service";
import {
  billingEvent,
  openAttemptStatuses,
  paymentAttempt,
  subscription,
  type BillingEventRow,
  type PaymentAttemptRow,
  type SubscriptionRow,
} from "./schema";

const HOUR_MS = 3_600_000;
const HISTORY_LIMIT = 100;

type Language = "kk" | "ru" | "en";

function mine(
  row: SubscriptionRow,
  sources: { granted: boolean; until: Date | null },
): MySubscription {
  return {
    status: row.status,
    grantsAccess: sources.granted,
    statusConfirmed: row.status !== "expired_unconfirmed",
    periodEnd: row.currentPeriodEnd.toISOString(),
    accessUntil: sources.until?.toISOString() ?? null,
    graceUntil: row.graceUntil?.toISOString() ?? null,
    provider: row.provider,
    platform: row.purchasePlatform,
  };
}

function manualGrant(sources: ClubAccessSources) {
  return sources.manualUntil ? { validUntil: sources.manualUntil.toISOString() } : null;
}

function historyEntry(row: BillingEventRow): SubscriptionHistoryEntry {
  return {
    id: row.id,
    kind: row.kind,
    by: row.source,
    eventAt: row.eventAt.toISOString(),
    receivedAt: row.receivedAt.toISOString(),
    outcome: row.outcome,
    detail: row.detail,
    fromStatus: row.fromStatus,
    toStatus: row.toStatus,
    periodEnd: row.payload.periodEnd ?? null,
  };
}

/** A charge as the history of S-BILL-01 shows it: an answer still awaited is `in_progress`. */
export function chargeView(row: PaymentAttemptRow): SupplierCharge {
  const done = row.status === "succeeded" || row.status === "declined";
  return {
    id: row.id,
    kind: row.kind,
    outcome:
      row.status === "succeeded"
        ? "succeeded"
        : row.status === "declined"
          ? "declined"
          : "in_progress",
    declineReason: row.status === "declined" ? row.declineReason : null,
    amount: row.amount,
    currency: row.currency,
    periodFrom: row.periodFrom.toISOString(),
    periodTo: row.periodTo.toISOString(),
    at: row.createdAt.toISOString(),
    resolvedAt: done ? (row.resolvedAt?.toISOString() ?? null) : null,
    retryAt: !done && row.nextTryAt ? row.nextTryAt.toISOString() : null,
  };
}

/** A page boundary of the history: where the last row of the page was made. */
function encodeCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`).toString("base64url");
}

function decodeCursor(cursor: string | undefined): { at: string; id: string } | null {
  if (!cursor) return null;
  try {
    const [at, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    if (at && id && !Number.isNaN(Date.parse(at)) && /^[0-9a-f-]{36}$/i.test(id)) return { at, id };
  } catch {
    // Falls through to the refusal below.
  }
  throw new ApiException(400, "VALIDATION_ERROR", "The page cursor is not valid", {
    details: [{ path: "cursor", message: "The page cursor is not valid" }],
  });
}

/**
 * What a subscription looks like to whom (TASK-040; ARCHITECTURE 4.72): the
 * owner on any device (`GET /me/subscription`, M-SUB-02), the company in its
 * cabinet (D-041 and its tariff, S-BILL-01 comes with TASK-042), the
 * administrator (A-USR-02 «Клубный доступ»). Access is read only through
 * `ClubAccess`.
 */
@Injectable()
export class SubscriptionViews {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ClubAccess) private readonly clubAccess: ClubAccess,
    @Inject(Plans) private readonly plans: Plans,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(PaymentMethods) private readonly methods: PaymentMethods,
  ) {}

  async mine(accountId: string, language: Language): Promise<MySubscriptionResponse> {
    const now = new Date();
    const [sources, screens] = await Promise.all([
      this.clubAccess.sourcesOf(accountId, this.database.db, now),
      this.plans.forScreens("user", language, now),
    ]);
    return {
      subscription: sources.subscription
        ? mine(sources.subscription, sources.subscriptionAccess)
        : null,
      access: sources.access,
      manualGrant: manualGrant(sources),
      ...screens,
    };
  }

  async ofSupplier(supplierId: string, language: Language): Promise<SupplierSubscriptionResponse> {
    const now = new Date();
    const [[company], cardRequired, screens, method, current] = await Promise.all([
      this.database.db
        .select({
          cardLinkedAt: supplier.cardLinkedAt,
          adminPausedAt: supplier.adminPausedAt,
          billingPausedAt: supplier.billingPausedAt,
        })
        .from(supplier)
        .where(eq(supplier.id, supplierId)),
      // As the rule of the showcase reads it, so the words match what clients see.
      supplierCardRequired(this.database.db),
      this.plans.forScreens("supplier", language),
      this.methods.active(this.database.db, supplierId),
      this.currentOf(supplierId),
    ]);
    const cardLinked = Boolean(company?.cardLinkedAt);
    const [summary, inProgress] = await Promise.all([
      current ? this.summaryOf(current, now) : Promise.resolve(null),
      this.inProgress(supplierId),
    ]);
    const owes =
      current !== null &&
      (current.status === "past_due" ||
        current.status === "suspended" ||
        (current.status === "active" && current.currentPeriodEnd.getTime() <= now.getTime()));
    return {
      cardLinked,
      cardRequired,
      hiddenWithoutCard: cardRequired && !cardLinked,
      ...screens,
      subscription: summary,
      card: method ? this.methods.view(method, now) : null,
      pauses: {
        admin: company?.adminPausedAt != null,
        billing: company?.billingPausedAt != null,
      },
      actions: {
        canPayNow: method !== null && owes,
        inProgress,
        canStart: screens.plan !== null,
      },
    };
  }

  /** The company's current subscription (every status but `expired`), if it has one. */
  private async currentOf(supplierId: string): Promise<SubscriptionRow | null> {
    const [row] = await this.database.db
      .select()
      .from(subscription)
      .where(and(eq(subscription.supplierId, supplierId), ne(subscription.status, "expired")));
    return row ?? null;
  }

  /** A charge is waiting for the provider, or a card's first charge is on its way. */
  private async inProgress(supplierId: string): Promise<boolean> {
    const [open] = await this.database.db
      .select({ id: paymentAttempt.id })
      .from(paymentAttempt)
      .where(
        and(
          eq(paymentAttempt.supplierId, supplierId),
          inArray(paymentAttempt.status, [...openAttemptStatuses]),
        ),
      )
      .limit(1);
    return open !== undefined;
  }

  /** S-BILL-01's facts about a subscription: what it costs next, when the card is charged, the last refusal. */
  async summaryOf(sub: SubscriptionRow, now: Date): Promise<SupplierSubscriptionSummary> {
    const [hour, retryDays, nextPlan, declined] = await Promise.all([
      this.settings.get("billing_notify_hour"),
      this.settings.get("billing_retry_days"),
      this.plans.inEffect(
        "supplier",
        sub.currentPeriodEnd.getTime() > now.getTime() ? sub.currentPeriodEnd : now,
      ),
      this.database.db
        .select({ resolvedAt: paymentAttempt.resolvedAt, reason: paymentAttempt.declineReason })
        .from(paymentAttempt)
        .where(
          and(
            eq(paymentAttempt.periodKey, termKey(sub.id, sub.currentPeriodEnd)),
            eq(paymentAttempt.status, "declined"),
          ),
        )
        .orderBy(desc(paymentAttempt.resolvedAt)),
    ]);
    let nextChargeAt: Date | null = null;
    if (sub.status === "active") {
      const due = nextDailyRun(new Date(sub.currentPeriodEnd.getTime() - 1), hour);
      nextChargeAt = due.getTime() > now.getTime() ? due : nextDailyRun(now, hour);
    } else if (sub.status === "past_due") {
      // The retry W-05 promised (one rule with it, the daily job and A-BILL-03, I836, I849).
      nextChargeAt = pastDueNextRetry({
        declinedCount: declined.length,
        lastDeclinedAt: declined[0]?.resolvedAt ?? null,
        graceUntil: sub.graceUntil,
        retryDays,
        hour,
        now,
      });
    }
    const last = declined[0];
    return {
      status: sub.status as SupplierSubscriptionSummary["status"],
      periodEnd: sub.currentPeriodEnd.toISOString(),
      graceUntil: sub.graceUntil?.toISOString() ?? null,
      amount: nextPlan?.price ?? null,
      nextChargeAt: nextChargeAt?.toISOString() ?? null,
      lastDecline:
        last?.resolvedAt && last.reason
          ? { at: last.resolvedAt.toISOString(), reason: last.reason }
          : null,
    };
  }

  /** The history of a company's charges, newest first, by pages (S-BILL-01). */
  async chargesOf(
    supplierId: string,
    query: { limit: number; cursor?: string },
  ): Promise<SupplierChargePage> {
    const cursor = decodeCursor(query.cursor);
    const rows = await this.database.db
      .select()
      .from(paymentAttempt)
      .where(
        and(
          eq(paymentAttempt.supplierId, supplierId),
          ne(paymentAttempt.status, "cancelled"),
          cursor
            ? sql`(${paymentAttempt.createdAt}, ${paymentAttempt.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(paymentAttempt.createdAt), desc(paymentAttempt.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      charges: page.map(chargeView),
      nextCursor: rows.length > query.limit && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }

  /** The «Подписка» block of the supplier card (A-SUP-03). */
  async forAdminSupplier(supplierId: string): Promise<AdminSupplierBillingResponse> {
    const now = new Date();
    const [company] = await this.database.db
      .select({
        adminPausedAt: supplier.adminPausedAt,
        adminPauseNote: supplier.adminPauseNote,
        billingPausedAt: supplier.billingPausedAt,
      })
      .from(supplier)
      .where(eq(supplier.id, supplierId));
    if (!company) throw new ApiException(404, "NOT_FOUND", "No such supplier");
    const [method, current, screens, charges] = await Promise.all([
      this.methods.active(this.database.db, supplierId),
      this.currentOf(supplierId),
      this.plans.forScreens("supplier", "ru", now),
      this.chargesOf(supplierId, { limit: 50 }),
    ]);
    const subscriptionIds = (
      await this.database.db
        .select({ id: subscription.id })
        .from(subscription)
        .where(eq(subscription.supplierId, supplierId))
    ).map((row) => row.id);
    const history = await this.database.db
      .select()
      .from(billingEvent)
      .where(
        or(
          eq(billingEvent.supplierId, supplierId),
          subscriptionIds.length > 0
            ? inArray(billingEvent.subscriptionId, subscriptionIds)
            : undefined,
        ),
      )
      .orderBy(desc(billingEvent.receivedAt), desc(billingEvent.eventAt))
      .limit(HISTORY_LIMIT);
    return {
      subscription: current ? await this.summaryOf(current, now) : null,
      card: method ? this.methods.view(method, now) : null,
      pauses: {
        admin: company.adminPausedAt
          ? { note: company.adminPauseNote, since: company.adminPausedAt.toISOString() }
          : null,
        billing: company.billingPausedAt ? { since: company.billingPausedAt.toISOString() } : null,
      },
      charges: charges.charges,
      history: history.map(historyEntry),
      plan: screens.plan,
      announcedPlan: screens.announcedPlan,
    };
  }

  async forAdmin(accountId: string): Promise<AdminUserSubscriptionResponse> {
    const now = new Date();
    const [person] = await this.database.db
      .select({ id: account.id })
      .from(account)
      .where(eq(account.id, accountId));
    if (!person) {
      throw new ApiException(404, "NOT_FOUND", "No such user");
    }
    const [sources, rows, toleranceHours] = await Promise.all([
      this.clubAccess.sourcesOf(accountId, this.database.db, now),
      this.database.db
        .select()
        .from(subscription)
        .where(and(eq(subscription.accountId, accountId), eq(subscription.audience, "user")))
        .orderBy(desc(subscription.createdAt)),
      this.settings.get("store_lag_tolerance_hours"),
    ]);
    const shown = sources.subscription ?? rows[0] ?? null;
    const ids = rows.map((row) => row.id);
    // The events naming the account (a purchase it brought, time's events)
    // and those of its subscriptions that name only the purchase.
    const history = await this.database.db
      .select()
      .from(billingEvent)
      .where(
        or(
          eq(billingEvent.accountId, accountId),
          ids.length > 0 ? inArray(billingEvent.subscriptionId, ids) : undefined,
        ),
      )
      .orderBy(desc(billingEvent.receivedAt), desc(billingEvent.eventAt))
      .limit(HISTORY_LIMIT);
    let view: AdminUserSubscription | null = null;
    if (shown) {
      const access = subscriptionAccess(
        {
          status: shown.status,
          periodEnd: shown.currentPeriodEnd,
          graceUntil: shown.graceUntil,
          unconfirmedSince: shown.unconfirmedSince,
        },
        now,
        toleranceHours * HOUR_MS,
      );
      view = {
        ...mine(shown, access),
        id: shown.id,
        providerRef: shown.providerRef,
        createdAt: shown.createdAt.toISOString(),
        updatedAt: shown.updatedAt.toISOString(),
      };
    }
    return {
      subscription: view,
      history: history.map(historyEntry),
      access: sources.access,
      manualGrant: manualGrant(sources),
    };
  }
}
