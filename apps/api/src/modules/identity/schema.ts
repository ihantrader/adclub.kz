import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * `account` (ARCHITECTURE 5.1): the single identity a phone number owns,
 * whatever role it plays (user, supplier employee, admin — those role
 * tables arrive with the tasks that own them, EPIC-02). No business logic
 * lives here yet (TASK-002 scope); this only mirrors the table created by
 * `infra/migrations/1789583044021_create-account.sql`, which is the
 * source of truth — keep the two in sync by hand until the schema is rich
 * enough to justify `drizzle-kit generate` (see ARCHITECTURE.md).
 */
export const account = pgTable("account", {
  id: uuid("id").primaryKey().defaultRandom(),
  phone: text("phone").notNull(),
  email: text("email"),
  status: text("status").notNull().default("active"),
  consentPhoneShareAt: timestamp("consent_phone_share_at", { withTimezone: true }),
  consentVersion: text("consent_version"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
