import { Inject, Injectable, Logger } from "@nestjs/common";
import { BILLING_SUBJECT_ID, type PaymentDeclineReason } from "@adclub/contracts";
import {
  bankRetriesLeft,
  BILLING_TIME_ZONE,
  firstPeriod,
  localDateTime,
  renewalPeriod,
  retryWindowEnd,
} from "@adclub/domain";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { ApiException } from "../../common/errors";
import { DatabaseService, type DbExecutor } from "../../database";
import { JobQueue } from "../../jobs";
import { supplierMember } from "../identity";
import type { AuditActorRecord } from "../audit";
import { AppSettings } from "../settings";
import { Plans } from "./plans.service";
import { BillingNotices, localDay } from "./billing-notices";
import { runPaymentAttemptJob } from "./billing-jobs";
import { PaymentMethods } from "./payment-methods";
import {
  PaymentProvider,
  PaymentProviderUnavailableError,
  type ChargeResult,
} from "./payment-provider";
import { PaymentTokenVault, tokenContext } from "./payment-token-vault";
import {
  cardBinding,
  openAttemptStatuses,
  paymentAttempt,
  paymentMethod,
  subscription,
  type PaymentAttemptKind,
  type PaymentAttemptRow,
  type PaymentMethodRow,
  type SubscriptionRow,
} from "./schema";
import { BINDING_REF_PREFIX, SupplierBillingEffects } from "./supplier-billing-effects";
import { SubscriptionEvents } from "./subscription-events";

/** How long a worker holds an attempt while it talks to the provider. */
const CLAIM_SECONDS = 120;

/** The settings an outcome needs, read before the transaction that settles it. */
interface Tuning {
  retryDays: number;
  hour: number;
  notifiedLimit: number;
  retryMinutes: number;
}

/** No tariff for suppliers is in effect: nothing can be charged or started. */
export class NoPlanError extends Error {
  constructor() {
    super("No tariff for suppliers is in effect");
  }
}

/** What became of an attempt, as the provider said it (or the lookup of it). */
export type AttemptOutcome =
  | { kind: "succeeded"; providerPaymentId: string | null }
  | { kind: "declined"; reason: PaymentDeclineReason; providerPaymentId: string | null }
  | { kind: "unavailable"; detail: string }
  | { kind: "unknown"; detail: string };

export type OpenedAttempt = { kind: "opened" | "existing" | "paid"; attempt: PaymentAttemptRow };

function isOpen(status: PaymentAttemptRow["status"]): boolean {
  return (openAttemptStatuses as readonly string[]).includes(status);
}

function compact(id: string): string {
  return id.replaceAll("-", "");
}

/** The term an attempt pays, as a key: the same term is the same key whoever asks. */
export function termKey(subscriptionId: string, periodFrom: Date): string {
  return `${subscriptionId}:${periodFrom.toISOString()}`;
}

function providerKey(
  periodKey: string,
  subscriptionId: string | null,
  bindingId: string | null,
  periodFrom: Date,
  no: number,
): string {
  // The moment itself, not its day: two terms starting on one UTC day are two payments.
  const moment = String(periodFrom.getTime());
  return bindingId
    ? `b${compact(bindingId)}n${String(no)}`
    : `s${compact(subscriptionId ?? periodKey)}p${moment}n${String(no)}`;
}

/**
 * Charges a supplier's card (PRODUCT 14.1, 14.3; ARCHITECTURE 9.4.2, 18.5,
 * 4.77; TASK-042). One thing is guaranteed above all: **a term is never
 * paid twice**, whatever repeats, races or crashes. It rests on two halves:
 *
 * - **ours — the database.** A charge is an attempt row. Per term
 *   (`period_key`) a unique index admits one success, and another admits one
 *   attempt that is not over; the attempt number is unique. The row of the
 *   subscription is locked while an attempt is opened, so two employees
 *   pressing «Оплатить сейчас», the daily job and a retry all meet in one
 *   place and get the same attempt back;
 * - **the provider's — the idempotency key.** The same key is the same
 *   payment. An attempt keeps its key through every retry (unavailable,
 *   unknown); only a refusal of the bank ends it and the next attempt gets a
 *   new key. A key whose answer may have been lost is **looked up first**
 *   (`getPayment`) — nothing is sent again to a provider that may have it.
 *
 * The provider is called with **no transaction open and no row locked**
 * (the claim is a short update with a lease; the outcome is settled in a
 * short transaction after): a slow acquirer never holds a lock, a crash
 * between the call and the settlement leaves an attempt the resolver finds
 * by its expired lease and looks up.
 */
@Injectable()
export class PaymentCharger {
  private readonly logger = new Logger("Billing");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(PaymentProvider) private readonly provider: PaymentProvider,
    @Inject(PaymentMethods) private readonly methods: PaymentMethods,
    @Inject(PaymentTokenVault) private readonly vault: PaymentTokenVault,
    @Inject(Plans) private readonly plans: Plans,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(SubscriptionEvents) private readonly events: SubscriptionEvents,
    @Inject(JobQueue) private readonly queue: JobQueue,
    @Inject(BillingNotices) private readonly notices: BillingNotices,
    @Inject(SupplierBillingEffects) private readonly effects: SupplierBillingEffects,
  ) {}

  // ------------------------------------------------------------ opening

  /**
   * The attempt that pays the term a subscription owes, in the caller's
   * transaction (which holds the subscription row): the term's success if it
   * has one, an attempt not over if there is one, otherwise a new one — with
   * the tariff in effect now and the period this payment buys.
   */
  async openForSubscription(
    tx: DbExecutor,
    sub: SubscriptionRow,
    method: PaymentMethodRow,
    kind: Exclude<PaymentAttemptKind, "first">,
    memberId: string | null,
    now: Date,
  ): Promise<OpenedAttempt> {
    const periodFrom = sub.currentPeriodEnd;
    const periodKey = termKey(sub.id, periodFrom);
    const existing = await tx
      .select()
      .from(paymentAttempt)
      .where(eq(paymentAttempt.periodKey, periodKey))
      .orderBy(desc(paymentAttempt.attemptNo));
    const paid = existing.find((row) => row.status === "succeeded");
    if (paid) return { kind: "paid", attempt: paid };
    const open = existing.find((row) => isOpen(row.status));
    if (open) return { kind: "existing", attempt: open };
    const plan = await this.plans.inEffect("supplier", now, tx);
    if (!plan) throw new NoPlanError();
    const [last] = await tx
      .select({ anchorDay: paymentAttempt.anchorDay })
      .from(paymentAttempt)
      .where(
        and(eq(paymentAttempt.supplierId, sub.supplierId!), eq(paymentAttempt.status, "succeeded")),
      )
      .orderBy(desc(paymentAttempt.resolvedAt))
      .limit(1);
    const anchorDay =
      last?.anchorDay ?? Number(localDateTime(periodFrom, BILLING_TIME_ZONE).date.slice(8, 10));
    const period = renewalPeriod(periodFrom, anchorDay, now);
    const no = (existing[0]?.attemptNo ?? 0) + 1;
    const [created] = await tx
      .insert(paymentAttempt)
      .values({
        supplierId: sub.supplierId!,
        subscriptionId: sub.id,
        paymentMethodId: method.id,
        planId: plan.id,
        kind,
        periodKey,
        attemptNo: no,
        idempotencyKey: providerKey(periodKey, sub.id, null, periodFrom, no),
        amount: plan.price,
        periodFrom,
        periodTo: period.end,
        anchorDay: period.anchorDay,
        provider: method.provider,
        requestedByMemberId: memberId,
      })
      .returning();
    return { kind: "opened", attempt: created! };
  }

  /** The first charge of a card trip: the term from today. Called with the binding row locked. */
  async openFirst(
    tx: DbExecutor,
    binding: {
      id: string;
      supplierId: string;
      provider: PaymentMethodRow["provider"];
      startedByMemberId: string | null;
    },
    now: Date,
  ): Promise<PaymentAttemptRow> {
    const plan = await this.plans.inEffect("supplier", now, tx);
    if (!plan) throw new NoPlanError();
    const period = firstPeriod(now);
    const periodKey = `${BINDING_REF_PREFIX}${binding.id}`;
    const [created] = await tx
      .insert(paymentAttempt)
      .values({
        supplierId: binding.supplierId,
        bindingId: binding.id,
        planId: plan.id,
        kind: "first",
        periodKey,
        attemptNo: 1,
        idempotencyKey: providerKey(periodKey, null, binding.id, now, 1),
        amount: plan.price,
        periodFrom: now,
        periodTo: period.end,
        anchorDay: period.anchorDay,
        provider: binding.provider,
        requestedByMemberId: binding.startedByMemberId,
      })
      .returning();
    return created!;
  }

  /** Puts an attempt on the queue (in the caller's transaction, or its own). */
  async schedule(attemptId: string, tx?: DbExecutor): Promise<void> {
    await this.queue.enqueue(
      runPaymentAttemptJob,
      { attemptId },
      { ...(tx && { tx }), singletonKey: attemptId },
    );
  }

  // ------------------------------------------------------------ the daily job

  /** The daily job's work for one subscription: open the term's attempt (or take the open one) and run it. */
  async chargeSubscription(subscriptionId: string, kind: "scheduled" | "retry"): Promise<void> {
    const retryDays = await this.settings.get("billing_retry_days");
    let attemptId: string | null;
    try {
      attemptId = await this.database.db.transaction(async (tx) => {
        const [sub] = await tx
          .select()
          .from(subscription)
          .where(eq(subscription.id, subscriptionId))
          .for("update");
        if (!sub || sub.audience !== "supplier" || !sub.supplierId) return null;
        const now = new Date();
        if (kind === "scheduled") {
          if (sub.status !== "active" || sub.currentPeriodEnd.getTime() > now.getTime())
            return null;
        } else {
          if (sub.status !== "past_due") return null;
          if (sub.graceUntil && sub.graceUntil.getTime() <= now.getTime()) return null;
        }
        const method = await this.methods.active(tx, sub.supplierId);
        if (!method) {
          this.logger.warn(`No card to charge subscription=${sub.id}`);
          return null;
        }
        if (kind === "retry") {
          const declined = await tx
            .select({ resolvedAt: paymentAttempt.resolvedAt })
            .from(paymentAttempt)
            .where(
              and(
                eq(paymentAttempt.periodKey, termKey(sub.id, sub.currentPeriodEnd)),
                eq(paymentAttempt.status, "declined"),
              ),
            );
          // The retries are the bank's refusals: three days, three tries, one a day.
          if (!bankRetriesLeft(declined.length, retryDays)) return null;
          if (
            declined.some((row) => row.resolvedAt && localDay(row.resolvedAt) === localDay(now))
          ) {
            return null;
          }
        }
        const opened = await this.openForSubscription(tx, sub, method, kind, null, now);
        if (opened.kind === "paid") return null;
        if (opened.kind === "opened") await this.schedule(opened.attempt.id, tx);
        return opened.attempt.id;
      });
    } catch (error) {
      if (error instanceof NoPlanError) {
        await this.signalMissingPlan();
        return;
      }
      throw error;
    }
    if (attemptId) await this.run(attemptId);
  }

  /**
   * «Оплатить сейчас»: the charge of the term the subscription owes. Two
   * employees at once meet on the subscription's row and get one attempt.
   */
  async payNow(supplierId: string, memberId: string): Promise<PaymentAttemptRow> {
    try {
      return await this.database.db.transaction(async (tx) => {
        const [sub] = await tx
          .select()
          .from(subscription)
          .where(
            and(eq(subscription.supplierId, supplierId), sql`${subscription.status} <> 'expired'`),
          )
          .for("update");
        const now = new Date();
        const owes =
          sub &&
          (sub.status === "past_due" ||
            sub.status === "suspended" ||
            (sub.status === "active" && sub.currentPeriodEnd.getTime() <= now.getTime()));
        const method = await this.methods.active(tx, supplierId);
        if (!sub || !owes) {
          throw new ApiException(409, "BILLING_NOTHING_TO_PAY", "The subscription is paid");
        }
        if (!method) {
          throw new ApiException(409, "BILLING_NO_CARD", "No card is linked");
        }
        const opened = await this.openForSubscription(tx, sub, method, "manual", memberId, now);
        if (opened.kind === "opened") await this.schedule(opened.attempt.id, tx);
        return opened.attempt;
      });
    } catch (error) {
      if (error instanceof NoPlanError) {
        await this.signalMissingPlan();
        throw new ApiException(409, "BILLING_NO_PLAN", "No tariff for suppliers is recorded");
      }
      throw error;
    }
  }

  // ------------------------------------------------------------ running

  /** One attempt at the provider: claim it, ask, settle what came back. */
  async run(attemptId: string): Promise<void> {
    const claimed = await this.claim(attemptId);
    if (!claimed) return;
    const outcome = await this.ask(claimed.attempt, claimed.token);
    await this.settle(attemptId, outcome);
  }

  private async claim(
    attemptId: string,
  ): Promise<{ attempt: PaymentAttemptRow; token: string } | null> {
    const [attempt] = await this.database.db
      .update(paymentAttempt)
      .set({
        claimedUntil: sql`now() + make_interval(secs => ${CLAIM_SECONDS})`,
        tries: sql`${paymentAttempt.tries} + 1`,
      })
      .where(
        and(
          eq(paymentAttempt.id, attemptId),
          inArray(paymentAttempt.status, [...openAttemptStatuses]),
          sql`(${paymentAttempt.claimedUntil} IS NULL OR ${paymentAttempt.claimedUntil} <= now())`,
        ),
      )
      .returning();
    if (!attempt) return null;
    if (attempt.kind === "first") {
      const [binding] = await this.database.db
        .select({ sealed: cardBinding.cardTokenSealed })
        .from(cardBinding)
        .where(eq(cardBinding.id, attempt.bindingId!));
      if (!binding?.sealed) {
        // The card the first charge was for is gone (the binding was cleaned): nothing to send.
        await this.settle(attempt.id, {
          kind: "unavailable",
          detail: "The card is no longer held",
        });
        return null;
      }
      return {
        attempt,
        token: this.vault.open(tokenContext.cardBinding(attempt.bindingId!), binding.sealed),
      };
    }
    const [method] = await this.database.db
      .select()
      .from(paymentMethod)
      .where(eq(paymentMethod.id, attempt.paymentMethodId!));
    return { attempt, token: this.methods.token(method!) };
  }

  /** Looks the payment up if it may have been sent, then sends it if it was not. */
  private async ask(attempt: PaymentAttemptRow, token: string): Promise<AttemptOutcome> {
    const mayBeSent = attempt.tries > 1 || attempt.status === "unknown";
    try {
      if (mayBeSent) {
        const found = await this.provider.getPayment(attempt.idempotencyKey);
        if (found.kind === "succeeded") {
          return { kind: "succeeded", providerPaymentId: found.providerPaymentId };
        }
        if (found.kind === "declined") {
          return {
            kind: "declined",
            reason: found.reason,
            providerPaymentId: found.providerPaymentId,
          };
        }
        if (found.kind === "unavailable") {
          // Not charged for sure only if it never went out.
          return attempt.status === "unavailable"
            ? { kind: "unavailable", detail: found.detail }
            : { kind: "unknown", detail: found.detail };
        }
        // not_found: the provider has no such payment — safe to send it (the key makes a repeat harmless).
      }
      const result: ChargeResult = await this.provider.charge({
        idempotencyKey: attempt.idempotencyKey,
        token,
        amount: attempt.amount,
        currency: attempt.currency,
        description: "Подписка adclub.kz",
      });
      return result;
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown error";
      return error instanceof PaymentProviderUnavailableError
        ? { kind: "unavailable", detail }
        : { kind: "unknown", detail };
    }
  }

  // ------------------------------------------------------------ settling

  /** Settles an outcome; an attempt already over is left as it is (a webhook was first). */
  async settle(attemptId: string, outcome: AttemptOutcome): Promise<"applied" | "stale"> {
    // Settings are read before the transaction opens, never inside it.
    const tuning = {
      ...(await this.notices.tuning()),
      retryMinutes: await this.settings.get("billing_provider_retry_minutes"),
    };
    return this.database.db.transaction(async (tx) => {
      const [attempt] = await tx
        .select()
        .from(paymentAttempt)
        .where(eq(paymentAttempt.id, attemptId))
        .for("update");
      if (!attempt || !isOpen(attempt.status)) {
        if (attempt && outcome.kind !== attempt.status) {
          this.logger.warn(
            `Late word about a settled attempt attempt=${attempt.id} was=${attempt.status} word=${outcome.kind}`,
          );
        }
        return "stale" as const;
      }
      await this.apply(tx, attempt, outcome, tuning);
      return "applied" as const;
    });
  }

  /** The provider's word by the key of the payment (its webhook). */
  async settleByKey(
    idempotencyKey: string,
    outcome: Extract<AttemptOutcome, { kind: "succeeded" | "declined" }>,
  ): Promise<"applied" | "stale" | "unknown_reference"> {
    const [attempt] = await this.database.db
      .select({ id: paymentAttempt.id })
      .from(paymentAttempt)
      .where(eq(paymentAttempt.idempotencyKey, idempotencyKey));
    if (!attempt) return "unknown_reference";
    return this.settle(attempt.id, outcome);
  }

  private async apply(
    tx: DbExecutor,
    attempt: PaymentAttemptRow,
    outcome: AttemptOutcome,
    tuning: Tuning,
  ): Promise<void> {
    switch (outcome.kind) {
      case "succeeded": {
        const [done] = await tx
          .update(paymentAttempt)
          .set({
            status: "succeeded",
            providerPaymentId: outcome.providerPaymentId,
            resolvedAt: sql`now()`,
            claimedUntil: null,
            nextTryAt: null,
          })
          .where(eq(paymentAttempt.id, attempt.id))
          .returning({ resolvedAt: paymentAttempt.resolvedAt });
        const at = done!.resolvedAt!;
        this.logger.log(`Payment succeeded attempt=${attempt.id} kind=${attempt.kind}`);
        if (attempt.kind === "first") {
          await this.completeFirst(tx, attempt, at);
          return;
        }
        const [sub] = await tx
          .select()
          .from(subscription)
          .where(eq(subscription.id, attempt.subscriptionId!));
        await this.events.receive(
          attempt.provider,
          {
            providerEventId: `${attempt.idempotencyKey}:paid`,
            kind: "renewed",
            providerRef: sub!.providerRef,
            accountId: null,
            supplierId: attempt.supplierId,
            eventAt: at,
            periodEnd: attempt.periodTo,
            graceUntil: null,
            platform: null,
          },
          "provider",
          tx,
        );
        return;
      }
      case "declined": {
        const [done] = await tx
          .update(paymentAttempt)
          .set({
            status: "declined",
            declineReason: outcome.reason,
            providerPaymentId: outcome.providerPaymentId,
            resolvedAt: sql`now()`,
            claimedUntil: null,
            nextTryAt: null,
          })
          .where(eq(paymentAttempt.id, attempt.id))
          .returning({ resolvedAt: paymentAttempt.resolvedAt });
        this.logger.log(
          `Payment declined attempt=${attempt.id} kind=${attempt.kind} reason=${outcome.reason}`,
        );
        if (attempt.kind === "first") {
          await this.endBinding(tx, attempt.bindingId!, "declined", outcome.reason);
          return;
        }
        await this.afterDecline(tx, attempt, done!.resolvedAt!, tuning);
        return;
      }
      case "unavailable":
      case "unknown": {
        if (attempt.kind === "first" && outcome.kind === "unavailable") {
          // Nobody is waiting an hour at a page: nothing was charged, the card is let go.
          await tx
            .update(paymentAttempt)
            .set({
              status: "cancelled",
              resolvedAt: sql`now()`,
              claimedUntil: null,
              nextTryAt: null,
              firstFailureAt: sql`coalesce(${paymentAttempt.firstFailureAt}, now())`,
              lastFailureAt: sql`now()`,
            })
            .where(eq(paymentAttempt.id, attempt.id));
          await this.endBinding(tx, attempt.bindingId!, "failed", "provider_unavailable");
          return;
        }
        const minutes = tuning.retryMinutes;
        await tx
          .update(paymentAttempt)
          .set({
            status: outcome.kind,
            claimedUntil: null,
            nextTryAt: sql`now() + make_interval(mins => ${minutes})`,
            firstFailureAt: sql`coalesce(${paymentAttempt.firstFailureAt}, now())`,
            lastFailureAt: sql`now()`,
          })
          .where(eq(paymentAttempt.id, attempt.id));
        this.logger.warn(
          `Payment provider did not settle attempt=${attempt.id} kind=${outcome.kind} detail=${outcome.detail}`,
        );
        return;
      }
    }
  }

  /** The first charge went through: the card is linked and the subscription begins. */
  private async completeFirst(tx: DbExecutor, attempt: PaymentAttemptRow, at: Date): Promise<void> {
    const [binding] = await tx
      .select()
      .from(cardBinding)
      .where(eq(cardBinding.id, attempt.bindingId!))
      .for("update");
    if (!binding?.cardTokenSealed || !binding.cardMask || !binding.cardBrand) {
      throw new Error(`The card of binding ${attempt.bindingId ?? "?"} is not held`);
    }
    const token = this.vault.open(tokenContext.cardBinding(binding.id), binding.cardTokenSealed);
    const { method } = await this.methods.link(tx, {
      supplierId: binding.supplierId,
      provider: binding.provider,
      token,
      mask: binding.cardMask,
      brand: binding.cardBrand,
      expMonth: binding.cardExpMonth!,
      expYear: binding.cardExpYear!,
      bindingId: binding.id,
      memberId: binding.startedByMemberId,
      actor: await this.actorOf(tx, binding.supplierId, binding.startedByMemberId),
    });
    await tx
      .update(cardBinding)
      .set({
        status: "completed",
        paymentMethodId: method.id,
        cardTokenSealed: null,
        finishedAt: at,
        updatedAt: sql`now()`,
      })
      .where(eq(cardBinding.id, binding.id));
    await tx
      .update(paymentAttempt)
      .set({ paymentMethodId: method.id })
      .where(eq(paymentAttempt.id, attempt.id));
    await this.events.receive(
      attempt.provider,
      {
        providerEventId: `${attempt.idempotencyKey}:paid`,
        kind: "started",
        providerRef: `${BINDING_REF_PREFIX}${binding.id}`,
        accountId: null,
        supplierId: binding.supplierId,
        eventAt: at,
        periodEnd: attempt.periodTo,
        graceUntil: null,
        platform: null,
      },
      "provider",
      tx,
    );
  }

  /** A trip that ended without a card (the bank refused, the provider failed). */
  private async endBinding(
    tx: DbExecutor,
    bindingId: string,
    status: "declined" | "failed",
    failure: string,
  ): Promise<void> {
    await tx
      .update(cardBinding)
      .set({ status, failure, finishedAt: sql`now()`, updatedAt: sql`now()` })
      .where(
        and(
          eq(cardBinding.id, bindingId),
          inArray(cardBinding.status, ["card_received", "charging"]),
        ),
      );
  }

  /** A refusal of the bank on a renewal: the retries start (or go on), the payer is told, the administrator sees. */
  private async afterDecline(
    tx: DbExecutor,
    attempt: PaymentAttemptRow,
    at: Date,
    tuning: Tuning,
  ): Promise<void> {
    const [sub] = await tx
      .select()
      .from(subscription)
      .where(eq(subscription.id, attempt.subscriptionId!))
      .for("update");
    if (!sub || (sub.status !== "active" && sub.status !== "past_due")) return;
    const declined = await tx
      .select({ resolvedAt: paymentAttempt.resolvedAt })
      .from(paymentAttempt)
      .where(
        and(eq(paymentAttempt.periodKey, attempt.periodKey), eq(paymentAttempt.status, "declined")),
      )
      .orderBy(asc(paymentAttempt.resolvedAt));
    // The window runs from the first refusal of the term, however the events are applied.
    const graceUntil = retryWindowEnd(declined[0]?.resolvedAt ?? at, tuning.retryDays);
    await this.events.receive(
      attempt.provider,
      {
        providerEventId: `${attempt.idempotencyKey}:declined`,
        kind: "payment_failed",
        providerRef: sub.providerRef,
        accountId: null,
        supplierId: attempt.supplierId,
        eventAt: at,
        periodEnd: null,
        graceUntil,
        platform: null,
      },
      "provider",
      tx,
    );
    await this.effects.raiseFailed(tx, attempt.supplierId, { ...sub, graceUntil });
    await this.notices.paymentFailed(tx, {
      subscriptionId: sub.id,
      supplierId: attempt.supplierId,
      declinedCount: declined.length,
      at,
      graceUntil,
      retryDays: tuning.retryDays,
      hour: tuning.hour,
      notifiedLimit: tuning.notifiedLimit,
    });
  }

  private async actorOf(
    tx: DbExecutor,
    supplierId: string,
    memberId: string | null,
  ): Promise<AuditActorRecord> {
    if (!memberId) return { role: "system" };
    const [member] = await tx
      .select({ accountId: supplierMember.accountId })
      .from(supplierMember)
      .where(eq(supplierMember.id, memberId));
    return member
      ? { role: "supplier", accountId: member.accountId, supplierId, memberId }
      : { role: "system" };
  }

  // ------------------------------------------------------------ the tariff

  /** Tells the administrator a charge or a subscription could not be made for lack of a tariff. */
  async signalMissingPlan(): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      await this.effects.raisePlanMissing(tx, BILLING_SUBJECT_ID);
    });
  }
}
