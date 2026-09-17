import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, sql } from "drizzle-orm";
import { DatabaseService, type DbExecutor } from "../../../database";
import { supplier, supplierMember, type SupplierStatus } from "../schema";

/** An active membership with the company it gives access to. */
export interface ActiveMembership {
  memberId: string;
  displayName: string;
  supplier: { id: string; name: string; city: string };
}

export interface SupplierRecord {
  id: string;
  name: string;
  city: string;
  status: SupplierStatus;
}

const membershipColumns = {
  memberId: supplierMember.id,
  displayName: supplierMember.displayName,
  supplier: { id: supplier.id, name: supplier.name, city: supplier.city },
};

const supplierColumns = {
  id: supplier.id,
  name: supplier.name,
  city: supplier.city,
  status: supplier.status,
};

/**
 * Companies and their employees (ARCHITECTURE 5.1, 5.5, 8.3), as far as
 * signing in and the session context need them. The supplier status
 * never filters here: pause and blocking don't close the cabinet.
 */
@Injectable()
export class SupplierMembershipStore {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /** Active memberships of the account, companies by name. */
  async listActive(
    accountId: string,
    executor: DbExecutor = this.database.db,
  ): Promise<ActiveMembership[]> {
    return executor
      .select(membershipColumns)
      .from(supplierMember)
      .innerJoin(supplier, eq(supplier.id, supplierMember.supplierId))
      .where(and(eq(supplierMember.accountId, accountId), eq(supplierMember.status, "active")))
      .orderBy(asc(supplier.name), asc(supplier.id));
  }

  /** The account's active membership in one company, if there is one. */
  async findActive(
    accountId: string,
    supplierId: string,
    executor: DbExecutor = this.database.db,
  ): Promise<ActiveMembership | undefined> {
    const [row] = await executor
      .select(membershipColumns)
      .from(supplierMember)
      .innerJoin(supplier, eq(supplier.id, supplierMember.supplierId))
      .where(
        and(
          eq(supplierMember.accountId, accountId),
          eq(supplierMember.supplierId, supplierId),
          eq(supplierMember.status, "active"),
        ),
      );
    return row;
  }

  async findSupplier(supplierId: string): Promise<SupplierRecord | undefined> {
    const [row] = await this.database.db
      .select(supplierColumns)
      .from(supplier)
      .where(eq(supplier.id, supplierId));
    return row;
  }

  // Operator command (development and tests only, see `cli/operator.ts`).

  async createSupplier(input: { name: string; city: string }): Promise<SupplierRecord> {
    const [row] = await this.database.db
      .insert(supplier)
      .values({ name: input.name, city: input.city })
      .returning(supplierColumns);
    return row!;
  }

  /**
   * Adds the owner of `accountId` to a company, or makes a removed
   * membership active again.
   */
  async addMember(input: {
    supplierId: string;
    accountId: string;
    displayName: string;
  }): Promise<{ memberId: string; created: boolean }> {
    const now = new Date();
    const [row] = await this.database.db
      .insert(supplierMember)
      .values({
        supplierId: input.supplierId,
        accountId: input.accountId,
        displayName: input.displayName,
        addedBy: "operator",
      })
      .onConflictDoUpdate({
        target: [supplierMember.accountId, supplierMember.supplierId],
        set: {
          status: "active",
          removedAt: null,
          displayName: input.displayName,
          updatedAt: now,
        },
      })
      .returning({ memberId: supplierMember.id, created: sql<boolean>`(xmax = 0)` });
    return row!;
  }

  /** Marks a membership removed; `false` if it wasn't active. */
  async removeMember(memberId: string): Promise<boolean> {
    const now = new Date();
    const rows = await this.database.db
      .update(supplierMember)
      .set({ status: "removed", removedAt: now, updatedAt: now })
      .where(and(eq(supplierMember.id, memberId), eq(supplierMember.status, "active")))
      .returning({ id: supplierMember.id });
    return rows.length > 0;
  }
}
