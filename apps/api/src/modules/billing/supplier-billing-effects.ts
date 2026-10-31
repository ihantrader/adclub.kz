import { Inject, Injectable, Logger } from "@nestjs/common";
import { auditActions, auditEntities, type AdminSignalPayload } from "@adclub/contracts";
import { supplierState, supplierVisibleOnShowcase } from "@adclub/domain";
import { and, desc, eq, sql } from "drizzle-orm";
import type { DbExecutor } from "../../database";
import { AuditLog } from "../audit";
import { supplier } from "../identity";
import { AdminSignals } from "../signals";
import { paymentAttempt, type SubscriptionRow } from "./schema";

/** The prefix of a first purchase's reference: `bind:<card binding id>`. */
export const BINDING_REF_PREFIX = "bind:";

/**
 * What a supplier's subscription does to the rest of the platform when its
 * status changes (PRODUCT 14.3; ARCHITECTURE 18.5, 4.77; TASK-042). Every
 * change of a status goes through `SubscriptionEvents` — an event of the
 * processor, or time — and calls this in the same transaction, so a status
 * and what follows from it never disagree:
 *
 * - **`suspended` ⇒ the billing pause holds, anything else ⇒ it does not.**
 *   The pause is a column of its own (`supplier.billing_paused_at`), apart
 *   from the administrator's: paying lifts this one and never touches the
 *   other, and the administrator lifting theirs never lifts this. The
 *   offers and orders are not touched — only what the showcase shows; the
 *   orders already taken are still handed out (PRODUCT 14.1);
 * - **the signal «Платёж поставщика не прошёл»** is open while the
 *   subscription is `past_due` or `suspended` and closes by itself when it
 *   is paid (or ends the other way);
 * - the first purchase's charge is linked to the subscription it created.
 *
 * The journal says who did it: the system, because of the subscription.
 */
@Injectable()
export class SupplierBillingEffects {
  private readonly logger = new Logger("Billing");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(AuditLog) private readonly audit: AuditLog,
    @Inject(AdminSignals) private readonly signals: AdminSignals,
  ) {}

  async afterChange(
    tx: DbExecutor,
    before: SubscriptionRow | null,
    after: SubscriptionRow,
  ): Promise<void> {
    if (after.audience !== "supplier" || !after.supplierId) return;
    const supplierId = after.supplierId;
    await this.followPause(tx, supplierId, after.status === "suspended");
    if (after.status === "past_due" || after.status === "suspended") {
      if (before?.status !== after.status) {
        await this.raiseFailed(tx, supplierId, after);
      }
    } else {
      await this.closeFailed(tx, supplierId, after);
    }
    if (before === null && after.providerRef.startsWith(BINDING_REF_PREFIX)) {
      await tx
        .update(paymentAttempt)
        .set({ subscriptionId: after.id })
        .where(
          and(
            eq(paymentAttempt.bindingId, after.providerRef.slice(BINDING_REF_PREFIX.length)),
            sql`${paymentAttempt.subscriptionId} IS NULL`,
          ),
        );
    }
  }

  /** The facts a signal about a failed payment carries. */
  private async failedPayload(
    tx: DbExecutor,
    supplierId: string,
    sub: SubscriptionRow,
  ): Promise<AdminSignalPayload> {
    const [company] = await tx
      .select({ name: supplier.name })
      .from(supplier)
      .where(eq(supplier.id, supplierId));
    const declined = await tx
      .select()
      .from(paymentAttempt)
      .where(and(eq(paymentAttempt.subscriptionId, sub.id), eq(paymentAttempt.status, "declined")))
      .orderBy(desc(paymentAttempt.resolvedAt))
      .limit(10);
    const latest = declined[0];
    const sameTerm = declined.filter((row) => row.periodKey === latest?.periodKey);
    return {
      supplierId,
      supplierName: company?.name,
      ...(latest?.declineReason && { declineReason: latest.declineReason }),
      declines: sameTerm.length,
      ...(sub.graceUntil && { graceUntil: sub.graceUntil.toISOString() }),
      ...(latest && { amount: latest.amount }),
      ...(sameTerm.length > 0 && {
        since: sameTerm[sameTerm.length - 1]!.resolvedAt?.toISOString(),
      }),
    };
  }

  /** Raises (or refreshes) the signal of a failed payment of the company. */
  async raiseFailed(tx: DbExecutor, supplierId: string, sub: SubscriptionRow): Promise<void> {
    await this.signals.raise(tx, {
      kind: "payment_failed",
      subjectType: "supplier",
      subjectId: supplierId,
      payload: await this.failedPayload(tx, supplierId, sub),
      at: new Date(),
    });
  }

  /** A charge or a subscription could not be made: no tariff for suppliers is recorded. */
  async raisePlanMissing(tx: DbExecutor, subjectId: string): Promise<void> {
    await this.signals.raise(tx, {
      kind: "billing_plan_missing",
      subjectType: "channel",
      subjectId,
      payload: { since: new Date().toISOString() },
      at: new Date(),
    });
  }

  /** A tariff is in effect again: the signal about the missing one is over. */
  async closePlanMissing(tx: DbExecutor, subjectId: string): Promise<boolean> {
    const open = await this.signals.openOf(tx, "billing_plan_missing", "channel", subjectId);
    if (!open) return false;
    return this.signals.close(tx, {
      kind: "billing_plan_missing",
      subjectType: "channel",
      subjectId,
      payload: { ...open.payload, endedAt: new Date().toISOString() },
      at: new Date(),
    });
  }

  private async closeFailed(tx: DbExecutor, supplierId: string, sub: SubscriptionRow) {
    const open = await this.signals.openOf(tx, "payment_failed", "supplier", supplierId);
    if (!open) return;
    await this.signals.close(tx, {
      kind: "payment_failed",
      subjectType: "supplier",
      subjectId: supplierId,
      payload: { ...open.payload, endedAt: new Date().toISOString() },
      at: new Date(),
    });
    this.logger.log(`Failed payment over supplier=${supplierId} status=${sub.status}`);
  }

  /** Puts or lifts the billing pause (and only it), with the company's state following. */
  private async followPause(tx: DbExecutor, supplierId: string, paused: boolean): Promise<void> {
    const [row] = await tx
      .select({
        adminPausedAt: supplier.adminPausedAt,
        billingPausedAt: supplier.billingPausedAt,
        blockedAt: supplier.blockedAt,
      })
      .from(supplier)
      .where(eq(supplier.id, supplierId))
      .for("update");
    if (!row || (row.billingPausedAt !== null) === paused) return;
    const facts = {
      adminPaused: row.adminPausedAt !== null,
      billingPaused: paused,
      blocked: row.blockedAt !== null,
    };
    const status = supplierState(facts);
    await tx
      .update(supplier)
      .set({
        billingPausedAt: paused ? sql`now()` : null,
        status,
        version: sql`${supplier.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(supplier.id, supplierId));
    await this.audit.record(
      {
        action: auditActions.supplierPauseChanged,
        actor: { role: "system" },
        entityType: auditEntities.supplier,
        entityId: supplierId,
        before: { paused: !paused, reason: "billing", adminPaused: facts.adminPaused },
        after: {
          paused,
          reason: "billing",
          adminPaused: facts.adminPaused,
          state: status,
          visibleOnShowcase: supplierVisibleOnShowcase(facts),
        },
        reason: paused ? "Подписка не оплачена: повторы списания закончились" : "Подписка оплачена",
      },
      tx,
    );
    this.logger.log(`Billing pause ${paused ? "put" : "lifted"} supplier=${supplierId}`);
  }
}
