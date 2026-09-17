import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { AuditActorRole } from "@adclub/contracts";

/**
 * Drizzle mirror of `audit_log` (`infra/migrations`,
 * `…_create-audit-log.sql` — the source of truth; ARCHITECTURE 5.12, 4.13).
 */
export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  action: text("action").notNull(),
  actorRole: text("actor_role").$type<AuditActorRole>().notNull(),
  actorAccountId: uuid("actor_account_id"),
  actorAdminId: uuid("actor_admin_id"),
  actorSupplierId: uuid("actor_supplier_id"),
  actorMemberId: uuid("actor_member_id"),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  before: jsonb("before").$type<unknown>(),
  after: jsonb("after").$type<unknown>(),
  reason: text("reason"),
  ip: text("ip"),
  userAgent: text("user_agent"),
  requestId: text("request_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const auditTables = [auditLog];
