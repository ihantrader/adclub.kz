import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  auditActions,
  auditEntities,
  type PhoneRevealSubject,
  type RevealPhoneResponse,
} from "@adclub/contracts";
import { maskPhone } from "@adclub/domain";
import { sql } from "drizzle-orm";
import { ApiException } from "../../common/errors";
import { DatabaseService, type DbExecutor } from "../../database";
import { AuditLog } from "../audit";
import type { AdminActor } from "./admin-users.service";

/** What the journal entry of one opening says, besides who opened it. */
interface RevealTarget {
  phone: string;
  entityType: string;
  /** Ids that tie the entry to the histories that should show it. */
  after: Record<string, unknown>;
}

/**
 * «Показать номер» (TASK-036.B; SCREENS 7.0): the one way a person's full
 * number reaches the admin panel. Every other admin answer carries it
 * partly hidden (`hidePhone`). Each opening is an entry of the action
 * journal **in the same transaction** as the read — who opened whose number,
 * on which object (an account, an employee, a connection request, an
 * order) — and never the number itself; the application log gets the
 * masked number at most (ARCHITECTURE 15.3). The route is limited per
 * administrator (`phone_reveal_per_account`).
 */
@Injectable()
export class PhoneReveals {
  private readonly logger = new Logger("PhoneReveals");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditLog) private readonly audit: AuditLog,
  ) {}

  async reveal(
    subject: PhoneRevealSubject,
    id: string,
    admin: AdminActor,
  ): Promise<RevealPhoneResponse> {
    const phone = await this.database.db.transaction(async (tx) => {
      const target = await this.targetOf(tx, subject, id);
      if (!target) {
        throw new ApiException(404, "NOT_FOUND", "Nothing with such a number");
      }
      await this.audit.record(
        {
          action: auditActions.phoneRevealed,
          actor: { role: "admin", accountId: admin.accountId, adminId: admin.adminId },
          entityType: target.entityType,
          entityId: id,
          after: { subject, ...target.after },
        },
        tx,
      );
      return target.phone;
    });
    this.logger.log(
      `Phone revealed subject=${subject}:${id} phone=${maskPhone(phone)} admin=${admin.adminId}`,
    );
    return { phone };
  }

  private async targetOf(
    tx: DbExecutor,
    subject: PhoneRevealSubject,
    id: string,
  ): Promise<RevealTarget | null> {
    switch (subject) {
      case "account": {
        const found = await tx.execute<{ phone: string }>(
          sql`SELECT phone FROM account WHERE id = ${id}::uuid`,
        );
        const row = found.rows[0];
        return row
          ? { phone: row.phone, entityType: auditEntities.account, after: { accountId: id } }
          : null;
      }
      case "supplier_member": {
        const found = await tx.execute<{ phone: string; supplier_id: string; account_id: string }>(
          sql`SELECT person.phone, member.supplier_id, member.account_id
              FROM supplier_member AS member JOIN account AS person ON person.id = member.account_id
              WHERE member.id = ${id}::uuid`,
        );
        const row = found.rows[0];
        return row
          ? {
              phone: row.phone,
              entityType: auditEntities.supplierMember,
              // The company's history and the person's own find the entry.
              after: { supplierId: row.supplier_id, accountId: row.account_id },
            }
          : null;
      }
      case "supplier_lead": {
        const found = await tx.execute<{ phone: string }>(
          sql`SELECT phone FROM supplier_lead WHERE id = ${id}::uuid`,
        );
        const row = found.rows[0];
        return row ? { phone: row.phone, entityType: auditEntities.supplierLead, after: {} } : null;
      }
      case "order": {
        const found = await tx.execute<{ phone: string; number: number; account_id: string }>(
          sql`SELECT person.phone, purchase.number, purchase.user_account_id AS account_id
              FROM customer_order AS purchase JOIN account AS person ON person.id = purchase.user_account_id
              WHERE purchase.id = ${id}::uuid`,
        );
        const row = found.rows[0];
        return row
          ? {
              phone: row.phone,
              entityType: auditEntities.order,
              after: { number: Number(row.number), accountId: row.account_id },
            }
          : null;
      }
    }
  }
}
