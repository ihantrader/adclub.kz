import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, lt, or, sql, type SQL } from "drizzle-orm";
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
  /** Only entries older than this position (keyset paging). */
  before?: { createdAt: Date; id: string };
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
};

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
      // Keyset paging: everything strictly older than the last entry read.
      filter.before
        ? or(
            lt(auditLog.createdAt, filter.before.createdAt),
            and(
              eq(auditLog.createdAt, filter.before.createdAt),
              lt(auditLog.id, sql`${filter.before.id}::uuid`),
            ),
          )
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
