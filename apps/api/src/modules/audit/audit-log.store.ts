import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import type { AuditActorRole } from "@adclub/contracts";
import { DatabaseService, type DbExecutor } from "../../database";
import { auditLog } from "./schema";

export interface AuditLogRow {
  id: string;
  action: string;
  actorRole: AuditActorRole;
  actorAccountId: string | null;
  actorAdminId: string | null;
  actorSupplierId: string | null;
  actorMemberId: string | null;
  entityType: string;
  entityId: string;
  before: unknown;
  after: unknown;
  reason: string | null;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
  createdAt: Date;
  /** `created_at` in UTC to the microsecond (`2026-09-18T03:14:33.123456Z`): the paging position. */
  position: string;
}

export interface NewAuditLogRow {
  action: string;
  actorRole: AuditActorRole;
  actorAccountId: string | null;
  actorAdminId: string | null;
  actorSupplierId: string | null;
  actorMemberId: string | null;
  entityType: string;
  entityId: string;
  before: unknown;
  after: unknown;
  reason: string | null;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

export interface AuditLogFilter {
  from?: Date;
  to?: Date;
  action?: string;
  entityType?: string;
  entityId?: string;
  actorAccountId?: string;
  actorRole?: AuditActorRole;
  /** The history of one catalog item: see `itemHistory`. */
  itemId?: string;
  /** The history of one supplier: see `supplierHistory`. */
  supplierId?: string;
  /** The history of one user: see `accountHistory`. */
  accountId?: string;
  /** Only entries older than this position (keyset paging, `position` of an entry). */
  before?: { position: string; id: string };
  limit: number;
}

const columns = {
  id: auditLog.id,
  action: auditLog.action,
  actorRole: auditLog.actorRole,
  actorAccountId: auditLog.actorAccountId,
  actorAdminId: auditLog.actorAdminId,
  actorSupplierId: auditLog.actorSupplierId,
  actorMemberId: auditLog.actorMemberId,
  entityType: auditLog.entityType,
  entityId: auditLog.entityId,
  before: auditLog.before,
  after: auditLog.after,
  reason: auditLog.reason,
  ip: auditLog.ip,
  userAgent: auditLog.userAgent,
  requestId: auditLog.requestId,
  createdAt: auditLog.createdAt,
  position: sql<string>`to_char(${auditLog.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
};

/**
 * Entity types whose entries belong to one catalog item by naming it in
 * `before`/`after` (`itemId`): its photos, compatibility records and
 * proposals (TASK-013, TASK-015).
 */
const ITEM_PART_ENTITIES = [
  "catalog_item_photo",
  "item_compatibility",
  "item_compatibility_proposal",
] as const;

/**
 * The history of one catalog item (SCREENS A-CAT-05 «История»; TASK-035):
 * the entries about the item and its translations (their entity is the
 * item), and those about its parts, which name it. Read from the journal
 * alone — the journal doesn't ask the catalog's tables.
 */
function itemHistory(itemId: string): SQL {
  const parts = sql.join(
    ITEM_PART_ENTITIES.map((entity) => sql`${entity}`),
    sql`, `,
  );
  return sql`(
    (${auditLog.entityType} IN ('catalog_item', 'catalog_translation') AND ${auditLog.entityId} = ${itemId})
    OR (${auditLog.entityType} IN (${parts})
      AND (${auditLog.after} ->> 'itemId' = ${itemId} OR ${auditLog.before} ->> 'itemId' = ${itemId}))
  )`;
}

/**
 * Entity types whose entries belong to one supplier by naming it in
 * `before`/`after` (`supplierId`): its employees and their invitations
 * (TASK-016, TASK-017).
 */
const SUPPLIER_PART_ENTITIES = ["supplier_member", "supplier_invitation"] as const;

/**
 * The history of one supplier (SCREENS A-SUP-03 «История»; TASK-036): the
 * entries about the company, those about its employees and invitations
 * (they name it), and every entry its cabinet made — offers, the schedule,
 * colleagues (`actor_supplier_id`). Read from the journal alone, like
 * `itemHistory`.
 */
function supplierHistory(supplierId: string): SQL {
  const parts = sql.join(
    SUPPLIER_PART_ENTITIES.map((entity) => sql`${entity}`),
    sql`, `,
  );
  return sql`(
    (${auditLog.entityType} = 'supplier' AND ${auditLog.entityId} = ${supplierId})
    OR (${auditLog.entityType} IN (${parts})
      AND (${auditLog.after} ->> 'supplierId' = ${supplierId} OR ${auditLog.before} ->> 'supplierId' = ${supplierId}))
    OR ${auditLog.actorSupplierId} = ${supplierId}
  )`;
}

/**
 * Entity types whose entries belong to one user by naming the account in
 * `after` (`accountId`): its club access grants, its discipline marks, the
 * numbers opened on its orders (TASK-020, TASK-022, TASK-036.B).
 */
const ACCOUNT_PART_ENTITIES = ["club_access_grant", "user_discipline_event", "order"] as const;

/**
 * The history of one user (SCREENS A-USR-02 «История»; TASK-036.B): the
 * entries about the account itself (registration, profile, sessions ended,
 * its number opened), those about its grants, marks and orders that name
 * it, and what the user did themselves (`actor_account_id` with the role
 * `user` — an employee's work in a cabinet is the supplier's history).
 * Read from the journal alone, like `itemHistory`.
 */
function accountHistory(accountId: string): SQL {
  const parts = sql.join(
    ACCOUNT_PART_ENTITIES.map((entity) => sql`${entity}`),
    sql`, `,
  );
  return sql`(
    (${auditLog.entityType} = 'account' AND ${auditLog.entityId} = ${accountId})
    OR (${auditLog.entityType} IN (${parts})
      AND (${auditLog.after} ->> 'accountId' = ${accountId} OR ${auditLog.before} ->> 'accountId' = ${accountId}))
    OR (${auditLog.actorRole} = 'user' AND ${auditLog.actorAccountId} = ${accountId})
  )`;
}

/**
 * Persistence of `audit_log` (ARCHITECTURE 4.13). Writing takes the
 * caller's executor: an entry belongs to the transaction of the action it
 * records. There is no update and no delete — the table refuses both.
 */
@Injectable()
export class AuditLogStore {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async append(row: NewAuditLogRow, executor: DbExecutor): Promise<AuditLogRow> {
    const [written] = await executor.insert(auditLog).values(row).returning(columns);
    if (!written) {
      throw new Error("The action was not recorded in the journal");
    }
    return written;
  }

  page(filter: AuditLogFilter, executor: DbExecutor = this.database.db): Promise<AuditLogRow[]> {
    const conditions: (SQL | undefined)[] = [
      filter.from ? gte(auditLog.createdAt, filter.from) : undefined,
      filter.to ? lt(auditLog.createdAt, filter.to) : undefined,
      filter.action ? eq(auditLog.action, filter.action) : undefined,
      filter.entityType ? eq(auditLog.entityType, filter.entityType) : undefined,
      filter.entityId ? eq(auditLog.entityId, filter.entityId) : undefined,
      filter.actorAccountId ? eq(auditLog.actorAccountId, filter.actorAccountId) : undefined,
      filter.actorRole ? eq(auditLog.actorRole, filter.actorRole) : undefined,
      filter.itemId ? itemHistory(filter.itemId) : undefined,
      filter.supplierId ? supplierHistory(filter.supplierId) : undefined,
      filter.accountId ? accountHistory(filter.accountId) : undefined,
      // Keyset paging: everything strictly older than the last entry read.
      // Compared at the database's own precision (microseconds), never
      // through a JavaScript `Date`.
      filter.before
        ? sql`(${auditLog.createdAt}, ${auditLog.id}) < (${filter.before.position}::timestamptz, ${filter.before.id}::uuid)`
        : undefined,
    ];
    return executor
      .select(columns)
      .from(auditLog)
      .where(and(...conditions))
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(filter.limit);
  }
}
