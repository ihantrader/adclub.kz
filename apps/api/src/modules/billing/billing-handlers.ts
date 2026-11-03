import { Inject, Injectable, Logger } from "@nestjs/common";
import { BILLING_SUBJECT_ID, PAYMENT_CHANNEL_SUBJECT_ID } from "@adclub/contracts";
import { and, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { DatabaseService } from "../../database";
import {
  JobQueue,
  type JobHandler,
  type JobRunContext,
  type JobRunOutcome,
  type PeriodicJobHandler,
} from "../../jobs";
import { AdminSignals } from "../signals";
import { AppSettings } from "../settings";
import { chargeSubscriptionJob } from "./billing-jobs";
import { CardBindings } from "./card-bindings";
import { PaymentCharger } from "./payment-charger";
import { PaymentMethods } from "./payment-methods";
import { PaymentProvider } from "./payment-provider";
import { PaymentWebhooks } from "./payment-webhooks";
import { Plans } from "./plans.service";
import { openAttemptStatuses, paymentAttempt, paymentMethod, subscription } from "./schema";
import { SupplierBillingEffects } from "./supplier-billing-effects";

/**
 * `billing.charge-due` — **daily at `billing_notify_hour`** (Almaty): every
 * company subscription whose term has ended is charged, and every one in
 * its retries gets today's try. Each goes to a job of its own: a slow
 * acquirer or a failing card holds up no other company.
 */
@Injectable()
export class ChargeDueHandler implements PeriodicJobHandler {
  private readonly logger = new Logger("Billing");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(JobQueue) private readonly queue: JobQueue,
  ) {}

  async run(_context: JobRunContext): Promise<JobRunOutcome> {
    const rows = await this.database.db
      .select({ id: subscription.id, status: subscription.status })
      .from(subscription)
      .where(
        and(
          eq(subscription.audience, "supplier"),
          or(
            and(eq(subscription.status, "active"), sql`${subscription.currentPeriodEnd} <= now()`),
            and(
              eq(subscription.status, "past_due"),
              sql`(${subscription.graceUntil} IS NULL OR ${subscription.graceUntil} > now())`,
            ),
          ),
        ),
      )
      .limit(2000);
    for (const row of rows) {
      await this.queue.enqueue(
        chargeSubscriptionJob,
        { subscriptionId: row.id, kind: row.status === "active" ? "scheduled" : "retry" },
        { singletonKey: row.id },
      );
    }
    if (rows.length > 0) {
      this.logger.log(`Daily charge: ${String(rows.length)} subscription(s) due`);
    }
    return { worked: rows.length > 0 };
  }
}

/** `billing.charge-subscription`: one company's charge for the term it owes. */
@Injectable()
export class ChargeSubscriptionHandler implements JobHandler<{
  subscriptionId: string;
  kind: "scheduled" | "retry";
}> {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(PaymentCharger) private readonly charger: PaymentCharger) {}

  async run(payload: { subscriptionId: string; kind: "scheduled" | "retry" }): Promise<void> {
    await this.charger.chargeSubscription(payload.subscriptionId, payload.kind);
  }
}

/** `billing.run-attempt`: one attempt at the provider. */
@Injectable()
export class RunAttemptHandler implements JobHandler<{ attemptId: string }> {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(PaymentCharger) private readonly charger: PaymentCharger) {}

  async run(payload: { attemptId: string }): Promise<void> {
    await this.charger.run(payload.attemptId);
  }
}

/**
 * `billing.resolve-attempts` — every minute: a charge the provider could not
 * take is tried again after `billing_provider_retry_minutes`, one whose
 * worker was lost (its lease ran out) is looked up and settled, one whose job
 * never started is started; a delivery of the provider nobody applied goes
 * back on the queue.
 */
@Injectable()
export class ResolvePaymentsHandler implements PeriodicJobHandler {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(PaymentCharger) private readonly charger: PaymentCharger,
    @Inject(PaymentWebhooks) private readonly webhooks: PaymentWebhooks,
  ) {}

  async run(_context: JobRunContext): Promise<JobRunOutcome> {
    const due = await this.database.db
      .select({ id: paymentAttempt.id })
      .from(paymentAttempt)
      .where(
        and(
          inArray(paymentAttempt.status, [...openAttemptStatuses]),
          or(
            and(
              inArray(paymentAttempt.status, ["unavailable", "unknown"]),
              or(isNull(paymentAttempt.nextTryAt), lte(paymentAttempt.nextTryAt, sql`now()`)),
              or(isNull(paymentAttempt.claimedUntil), lte(paymentAttempt.claimedUntil, sql`now()`)),
            ),
            and(
              eq(paymentAttempt.status, "created"),
              isNotNull(paymentAttempt.claimedUntil),
              lte(paymentAttempt.claimedUntil, sql`now()`),
            ),
            and(
              eq(paymentAttempt.status, "created"),
              isNull(paymentAttempt.claimedUntil),
              lte(paymentAttempt.createdAt, sql`now() - interval '60 seconds'`),
            ),
          ),
        ),
      )
      .limit(200);
    for (const row of due) {
      await this.charger.schedule(row.id);
    }
    const woke = await this.webhooks.wake();
    const detached = await this.webhooks.detachLeftovers();
    return { worked: due.length > 0 || woke > 0 || detached > 0 };
  }
}

/** `billing.finish-binding`: the card the provider named. */
@Injectable()
export class FinishBindingHandler implements JobHandler<{ bindingId: string }> {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(CardBindings) private readonly bindings: CardBindings) {}

  async run(payload: { bindingId: string }): Promise<void> {
    await this.bindings.finish(payload.bindingId);
  }
}

/** `billing.apply-payment-webhook`: one delivery of the provider. */
@Injectable()
export class ApplyPaymentWebhookHandler implements JobHandler<{ eventId: string }> {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(PaymentWebhooks) private readonly webhooks: PaymentWebhooks) {}

  async run(payload: { eventId: string }): Promise<void> {
    await this.webhooks.apply(payload.eventId);
  }
}

/** `billing.detach-card`: a replaced card is forgotten at the provider (retried while it is away). */
@Injectable()
export class DetachCardHandler implements JobHandler<{ paymentMethodId: string }> {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(PaymentProvider) private readonly provider: PaymentProvider,
    @Inject(PaymentMethods) private readonly methods: PaymentMethods,
  ) {}

  async run(payload: { paymentMethodId: string }): Promise<void> {
    // Under the card's row lock, which the settlement of a charge on it takes
    // too: a run that starts while that settlement is not committed waits for
    // it and sees the charge over, so it cannot wrongly find the card busy
    // after the settlement's own detach was dropped as a duplicate (I846).
    // The provider is called after the lock is gone.
    const method = await this.database.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(paymentMethod)
        .where(eq(paymentMethod.id, payload.paymentMethodId))
        .for("update");
      if (!row || row.detachedAt || row.status === "active") return null;
      // A charge not over stands on it: the charge's settlement puts this job back (I836).
      return (await this.methods.freeToDetach(tx, row.id)) ? row : null;
    });
    if (!method) return;
    await this.provider.detachCard(this.methods.token(method));
    await this.database.db
      .update(paymentMethod)
      .set({ detachedAt: sql`now()` })
      .where(eq(paymentMethod.id, method.id));
  }
}

/** `billing.expire-bindings`: pages nobody came back from, tokens left by trips without a card. */
@Injectable()
export class ExpireBindingsHandler implements PeriodicJobHandler {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(CardBindings) private readonly bindings: CardBindings) {}

  async run(_context: JobRunContext): Promise<JobRunOutcome> {
    const { expired, cleaned } = await this.bindings.expire();
    return { worked: expired + cleaned > 0 };
  }
}

/**
 * `billing.watch-provider` — every minute, two facts for the administrator:
 *
 * - **«Платёжная система недоступна»**: the provider has not taken a charge
 *   (unavailable, or its answer lost) for longer than
 *   `payment_outage_signal_minutes`. One signal about the provider itself;
 *   it closes by itself when no charge waits on it any more. Nobody is
 *   written to and nobody is paused for it;
 * - the missing tariff's signal closes once a tariff is in effect.
 */
@Injectable()
export class WatchProviderHandler implements PeriodicJobHandler {
  private readonly logger = new Logger("Billing");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AdminSignals) private readonly signals: AdminSignals,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(Plans) private readonly plans: Plans,
    @Inject(SupplierBillingEffects) private readonly effects: SupplierBillingEffects,
  ) {}

  async run(_context: JobRunContext): Promise<JobRunOutcome> {
    const minutes = await this.settings.get("payment_outage_signal_minutes");
    return this.database.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('billing.watch-provider'))`);
      const at = new Date();
      let worked = false;
      const [facts] = (
        await tx.execute<{
          failing: number;
          since: Date | string | null;
          last: Date | string | null;
        }>(sql`
          SELECT count(*)::int AS failing, min(first_failure_at) AS since, max(last_failure_at) AS last
          FROM payment_attempt WHERE status IN ('unavailable', 'unknown')
        `)
      ).rows;
      const failing = facts?.failing ?? 0;
      const since = facts?.since ? new Date(facts.since) : null;
      const last = facts?.last ? new Date(facts.last) : null;
      const open = await this.signals.openOf(
        tx,
        "payment_system_down",
        "channel",
        PAYMENT_CHANNEL_SUBJECT_ID,
      );
      if (failing > 0 && since && since.getTime() <= at.getTime() - minutes * 60_000) {
        const payload = {
          since: (open?.payload.since ?? since.toISOString()) || undefined,
          lastFailureAt: last?.toISOString(),
          failedPayments: failing,
          windowMinutes: minutes,
        };
        if (
          !open ||
          open.payload.lastFailureAt !== payload.lastFailureAt ||
          open.payload.failedPayments !== failing
        ) {
          await this.signals.raise(tx, {
            kind: "payment_system_down",
            subjectType: "channel",
            subjectId: PAYMENT_CHANNEL_SUBJECT_ID,
            payload,
            at,
          });
          worked = true;
          if (!open) this.logger.warn(`Payment provider silent failing=${String(failing)}`);
        }
      } else if (failing === 0 && open) {
        await this.signals.close(tx, {
          kind: "payment_system_down",
          subjectType: "channel",
          subjectId: PAYMENT_CHANNEL_SUBJECT_ID,
          payload: { ...open.payload, endedAt: at.toISOString() },
          at,
        });
        this.logger.log("Payment provider answers again");
        worked = true;
      }
      if (await this.plans.inEffect("supplier", at, tx)) {
        if (await this.effects.closePlanMissing(tx, BILLING_SUBJECT_ID)) worked = true;
      }
      return { worked };
    });
  }
}
