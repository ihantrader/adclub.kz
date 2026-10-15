import { Inject, Injectable } from "@nestjs/common";
import { auditActions, auditEntities } from "@adclub/contracts";
import { eq, sql } from "drizzle-orm";
import { ApiException } from "../../common/errors";
import { DatabaseService } from "../../database";
import { AuditLog } from "../audit";
import { supplier } from "../identity";

/**
 * Whether a company has linked a card (D-041; ARCHITECTURE 4.72; TASK-040):
 * `supplier.card_linked_at`, read by the rule of the showcase while the
 * switch `supplier_card_required` is on. Until the card processor
 * (TASK-042, which keeps it with the card itself) only the operator command
 * of development and tests sets it — through here, with the journal. It
 * changes no offer and no order, and not the company's version (it isn't
 * the company's card in the cabinet).
 */
@Injectable()
export class SupplierCards {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditLog) private readonly audit: AuditLog,
  ) {}

  async mark(
    supplierId: string,
    linked: boolean,
  ): Promise<{ supplierId: string; cardLinked: boolean; changed: boolean }> {
    return this.database.db.transaction(async (tx) => {
      const [company] = await tx
        .select({ id: supplier.id, cardLinkedAt: supplier.cardLinkedAt })
        .from(supplier)
        .where(eq(supplier.id, supplierId))
        .for("update");
      if (!company) {
        throw new ApiException(404, "NOT_FOUND", "No such supplier");
      }
      const was = company.cardLinkedAt !== null;
      if (was === linked) {
        return { supplierId, cardLinked: linked, changed: false };
      }
      await tx
        .update(supplier)
        .set({ cardLinkedAt: linked ? sql`now()` : null, updatedAt: sql`now()` })
        .where(eq(supplier.id, supplierId));
      await this.audit.record(
        {
          action: auditActions.supplierCardChanged,
          actor: { role: "operator" },
          entityType: auditEntities.supplier,
          entityId: supplierId,
          before: { cardLinked: was },
          after: { cardLinked: linked },
        },
        tx,
      );
      return { supplierId, cardLinked: linked, changed: true };
    });
  }
}
