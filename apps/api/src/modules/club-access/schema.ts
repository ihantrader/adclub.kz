import type { SubscriptionAudience, SubscriptionStatus } from "@adclub/domain";
import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { account, adminUser, supplier } from "../identity";

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

export type SubscriptionProviderName = "store" | "card_kz" | "test";

/**
 * The Drizzle mirror of `subscription` (`…_subscriptions.sql`; ARCHITECTURE
 * 5.10, 4.72; TASK-040): one purchase at its provider, its status — the
 * server's. The billing module writes it; it is described here, beside the
 * grants, because it is the other source of club access that `ClubAccess`
 * reads — so this module needs nothing of billing's (which itself reads
 * `ClubAccess`). The tariff (`plan_id`) is a foreign key in the database,
 * left out here like other references to another module's table.
 */
export const subscription = pgTable("subscription", {
  id: uuid("id").primaryKey().defaultRandom(),
  audience: text("audience").$type<SubscriptionAudience>().notNull(),
  accountId: uuid("account_id").references(() => account.id),
  supplierId: uuid("supplier_id").references(() => supplier.id),
  planId: uuid("plan_id"),
  provider: text("provider").$type<SubscriptionProviderName>().notNull(),
  purchasePlatform: text("purchase_platform").$type<"ios" | "android">(),
  providerRef: text("provider_ref").notNull(),
  status: text("status").$type<SubscriptionStatus>().notNull(),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }).notNull(),
  graceUntil: timestamp("grace_until", { withTimezone: true }),
  unconfirmedSince: timestamp("unconfirmed_since", { withTimezone: true }),
  lastProviderEventAt: timestamp("last_provider_event_at", { withTimezone: true }),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SubscriptionRow = typeof subscription.$inferSelect;

/** Every table this module describes — checked against the migrated database. */
export const clubAccessTables = [clubAccessGrant, subscription];
