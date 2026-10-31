import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { auditActions, auditEntities, type SupplierPaymentCard } from "@adclub/contracts";
import { and, eq, sql } from "drizzle-orm";
import { DatabaseService, type DbExecutor } from "../../database";
import { JobQueue } from "../../jobs";
import { AuditLog, type AuditActorRecord } from "../audit";
import { supplier } from "../identity";
import { detachCardJob } from "./billing-jobs";
import { PaymentTokenVault, tokenContext } from "./payment-token-vault";
import {
  paymentMethod,
  type CardBrand,
  type PaymentMethodRow,
  type PaymentProviderName,
} from "./schema";

export interface LinkCardInput {
  supplierId: string;
  provider: PaymentProviderName;
  /** The provider's token, plain: sealed here, never stored or logged as it is. */
  token: string;
  mask: string;
  brand: CardBrand;
  expMonth: number;
  expYear: number;
  bindingId: string | null;
  memberId: string | null;
  actor: AuditActorRecord;
}

/**
 * Whether a card's term has passed (the next charge to it will be refused):
 * a card is good through the last day of its month.
 */
export function cardExpired(
  card: { expMonth: number; expYear: number },
  at: Date = new Date(),
): boolean {
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth() + 1;
  return card.expYear < year || (card.expYear === year && card.expMonth < month);
}

/**
 * The card of a company's subscription (TASK-042; ARCHITECTURE 4.77).
 *
 * **The only place a card is linked, replaced or taken off — and the only
 * writer of `supplier.card_linked_at`**, which D-041 reads: the column
 * follows the card, in the same transaction, so «карта привязана» can never
 * disagree with the table. A new card replaces the old one (one active per
 * company, a unique index), and the old token is forgotten at the provider by
 * a job — the person is not kept waiting for it.
 *
 * The journal gets «карта привязана / заменена / снята» with the mask and
 * the brand, never the token.
 */
@Injectable()
export class PaymentMethods {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditLog) private readonly audit: AuditLog,
    @Inject(PaymentTokenVault) private readonly vault: PaymentTokenVault,
    @Inject(JobQueue) private readonly queue: JobQueue,
  ) {}

  async active(executor: DbExecutor, supplierId: string): Promise<PaymentMethodRow | null> {
    const [row] = await executor
      .select()
      .from(paymentMethod)
      .where(and(eq(paymentMethod.supplierId, supplierId), eq(paymentMethod.status, "active")));
    return row ?? null;
  }

  /** The token of a method, plain — only for a charge or a detach, only in memory. */
  token(method: PaymentMethodRow): string {
    return this.vault.open(tokenContext.paymentMethod(method.id), method.tokenSealed);
  }

  view(method: PaymentMethodRow, at: Date = new Date()): SupplierPaymentCard {
    return {
      mask: method.mask,
      brand: method.brand,
      expMonth: method.expMonth,
      expYear: method.expYear,
      expired: cardExpired(method, at),
      linkedAt: method.createdAt.toISOString(),
    };
  }

  /** Links a card (in the caller's transaction); an earlier active one is replaced. */
  async link(
    tx: DbExecutor,
    input: LinkCardInput,
  ): Promise<{ method: PaymentMethodRow; replaced: PaymentMethodRow | null }> {
    // One company's card is decided at a time.
    await tx
      .select({ id: supplier.id })
      .from(supplier)
      .where(eq(supplier.id, input.supplierId))
      .for("update");
    const previous = await this.active(tx, input.supplierId);
    if (previous) {
      await tx
        .update(paymentMethod)
        .set({ status: "replaced", replacedAt: sql`now()` })
        .where(eq(paymentMethod.id, previous.id));
    }
    const id = randomUUID();
    const [created] = await tx
      .insert(paymentMethod)
      .values({
        id,
        supplierId: input.supplierId,
        provider: input.provider,
        tokenSealed: this.vault.seal(tokenContext.paymentMethod(id), input.token),
        mask: input.mask,
        brand: input.brand,
        expMonth: input.expMonth,
        expYear: input.expYear,
        bindingId: input.bindingId,
        linkedByMemberId: input.memberId,
      })
      .returning();
    await tx
      .update(supplier)
      .set({ cardLinkedAt: sql`coalesce(${supplier.cardLinkedAt}, now())` })
      .where(eq(supplier.id, input.supplierId));
    await this.audit.record(
      {
        action: auditActions.supplierCardChanged,
        actor: input.actor,
        entityType: auditEntities.supplier,
        entityId: input.supplierId,
        before: previous
          ? { cardLinked: true, mask: previous.mask, brand: previous.brand }
          : { cardLinked: false },
        after: {
          cardLinked: true,
          change: previous ? "replaced" : "linked",
          mask: input.mask,
          brand: input.brand,
          expMonth: input.expMonth,
          expYear: input.expYear,
        },
      },
      tx,
    );
    if (previous) {
      await this.queue.enqueue(detachCardJob, { paymentMethodId: previous.id }, { tx });
    }
    return { method: created!, replaced: previous };
  }

  /** Takes the card off (the operator command of development and tests only). */
  async remove(tx: DbExecutor, supplierId: string, actor: AuditActorRecord): Promise<boolean> {
    const [company] = await tx
      .select({ id: supplier.id, cardLinkedAt: supplier.cardLinkedAt })
      .from(supplier)
      .where(eq(supplier.id, supplierId))
      .for("update");
    const previous = await this.active(tx, supplierId);
    if (!previous) {
      if (company?.cardLinkedAt) {
        // A mark left by the operator command before the card table existed
        // (TASK-040): there is no card behind it, so the mark goes.
        await tx.update(supplier).set({ cardLinkedAt: null }).where(eq(supplier.id, supplierId));
        await this.audit.record(
          {
            action: auditActions.supplierCardChanged,
            actor,
            entityType: auditEntities.supplier,
            entityId: supplierId,
            before: { cardLinked: true },
            after: { cardLinked: false, change: "removed" },
          },
          tx,
        );
        return true;
      }
      return false;
    }
    await tx
      .update(paymentMethod)
      .set({ status: "removed", replacedAt: sql`now()` })
      .where(eq(paymentMethod.id, previous.id));
    await tx.update(supplier).set({ cardLinkedAt: null }).where(eq(supplier.id, supplierId));
    await this.audit.record(
      {
        action: auditActions.supplierCardChanged,
        actor,
        entityType: auditEntities.supplier,
        entityId: supplierId,
        before: { cardLinked: true, mask: previous.mask, brand: previous.brand },
        after: { cardLinked: false, change: "removed" },
      },
      tx,
    );
    await this.queue.enqueue(detachCardJob, { paymentMethodId: previous.id }, { tx });
    return true;
  }
}
