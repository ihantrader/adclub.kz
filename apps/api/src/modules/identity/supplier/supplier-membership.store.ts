import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, sql } from "drizzle-orm";
import { DatabaseService, type DbExecutor } from "../../../database";
import { supplier, supplierCityName, supplierMember, type SupplierStatus } from "../schema";

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
  supplier: { id: supplier.id, name: supplier.name, city: supplierCityName },
};

const supplierColumns = {
  id: supplier.id,
  name: supplier.name,
  city: supplierCityName,
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

  /**
   * `listActive` for a transaction that is about to bind a session to one
   * of the memberships: the rows are share-locked until it commits, so a
   * concurrent removal waits and then ends that session too (or goes
   * first, and the membership is no longer listed).
   */
  async lockActive(accountId: string, tx: DbExecutor): Promise<ActiveMembership[]> {
    return tx
      .select(membershipColumns)
      .from(supplierMember)
      .innerJoin(supplier, eq(supplier.id, supplierMember.supplierId))
      .where(and(eq(supplierMember.accountId, accountId), eq(supplierMember.status, "active")))
      .orderBy(asc(supplier.name), asc(supplier.id))
      .for("share", { of: supplierMember });
  }

  /** The account's active membership in one company, share-locked as in `lockActive`. */
  async lockActiveIn(
    accountId: string,
    supplierId: string,
    tx: DbExecutor,
  ): Promise<ActiveMembership | undefined> {
    const [row] = await tx
      .select(membershipColumns)
      .from(supplierMember)
      .innerJoin(supplier, eq(supplier.id, supplierMember.supplierId))
      .where(
        and(
          eq(supplierMember.accountId, accountId),
          eq(supplierMember.supplierId, supplierId),
          eq(supplierMember.status, "active"),
        ),
      )
      .for("share", { of: supplierMember });
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

  /**
   * A company in the city of this code or name (any language, case
   * ignored), with its pickup point (every supplier has one, TASK-016).
   * A city the directory doesn't know is added (`source = 'operator'`):
   * the command is for development and tests, where the directory may be
   * empty. The real way to create a supplier is the admin panel
   * (`modules/suppliers`).
   */
  async createSupplier(
    input: { name: string; city: string },
    executor: DbExecutor = this.database.db,
  ): Promise<SupplierRecord> {
    const cityId = await this.cityFor(input.city, executor);
    const [row] = await executor
      .insert(supplier)
      .values({ name: input.name, cityId })
      .returning({ id: supplier.id });
    await executor.execute(sql`
      INSERT INTO supplier_location (supplier_id, city_id) VALUES (${row!.id}, ${cityId})
    `);
    const [created] = await executor
      .select(supplierColumns)
      .from(supplier)
      .where(eq(supplier.id, row!.id));
    return created!;
  }

  private async cityFor(text: string, executor: DbExecutor): Promise<string> {
    const found = await executor.execute<{ id: string }>(sql`
      SELECT id FROM city
      WHERE code = ${text} OR lower(${text}) IN (lower(name_ru), lower(name_kk), lower(name_en))
      ORDER BY status = 'active' DESC
      LIMIT 1
    `);
    if (found.rows[0]) {
      return found.rows[0].id;
    }
    const created = await executor.execute<{ id: string }>(sql`
      INSERT INTO city (code, name_ru, source, sort)
      VALUES (
        'city-' || substr(md5(random()::text), 1, 8),
        ${text},
        'operator',
        (SELECT coalesce(max(sort), -1) + 1 FROM city)
      )
      RETURNING id
    `);
    return created.rows[0]!.id;
  }

  /**
   * Adds the owner of `accountId` to a company, or makes a removed
   * membership active again.
   */
  async addMember(
    input: {
      supplierId: string;
      accountId: string;
      displayName: string;
      /** Who adds: the operator command (development) or an administrator (TASK-016). */
      addedBy?: "operator" | "admin";
    },
    executor: DbExecutor = this.database.db,
  ): Promise<{ memberId: string; created: boolean }> {
    const now = new Date();
    const [row] = await executor
      .insert(supplierMember)
      .values({
        supplierId: input.supplierId,
        accountId: input.accountId,
        displayName: input.displayName,
        addedBy: input.addedBy ?? "operator",
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

  /**
   * Marks a membership removed, in the caller's transaction (which must
   * also end the membership's sessions); `undefined` if it wasn't active.
   */
  async markRemoved(
    memberId: string,
    now: Date,
    tx: DbExecutor,
  ): Promise<{ accountId: string; supplierId: string } | undefined> {
    const [row] = await tx
      .update(supplierMember)
      .set({ status: "removed", removedAt: now, updatedAt: now })
      .where(and(eq(supplierMember.id, memberId), eq(supplierMember.status, "active")))
      .returning({ accountId: supplierMember.accountId, supplierId: supplierMember.supplierId });
    return row;
  }
}
