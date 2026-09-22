import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { account, adminUser } from "../identity";

/**
 * The Drizzle mirror of `club_access_grant` (`…_create-club-access.sql` —
 * the source of truth with the checks; ARCHITECTURE 4.29, D-059): a grant
 * of club access by hand, until a moment, with a reason. At most one grant
 * of an account is open (not ended by hand) — a partial unique index.
 */
export const clubAccessGrant = pgTable("club_access_grant", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => account.id),
  source: text("source").$type<"manual">().notNull().default("manual"),
  validUntil: timestamp("valid_until", { withTimezone: true }).notNull(),
  reason: text("reason").notNull(),
  grantedByRole: text("granted_by_role").$type<"admin" | "operator">().notNull(),
  grantedByAdminId: uuid("granted_by_admin_id").references(() => adminUser.id),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  endedHow: text("ended_how").$type<"revoked" | "replaced">(),
  endedByRole: text("ended_by_role").$type<"admin" | "operator">(),
  endedByAdminId: uuid("ended_by_admin_id").references(() => adminUser.id),
  endReason: text("end_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ClubAccessGrantRow = typeof clubAccessGrant.$inferSelect;

/** Every table this module owns — checked against the migrated database. */
export const clubAccessTables = [clubAccessGrant];
