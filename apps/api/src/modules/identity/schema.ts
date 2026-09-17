import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Drizzle mirrors of the tables in `infra/migrations` — the migrations are
 * the source of truth. Kept in sync by hand; the integration test
 * `database/schema-drift.integration.test.ts` fails CI when they differ
 * (ARCHITECTURE 4.5).
 */

/**
 * `account` (ARCHITECTURE 5.1): the single identity a phone number owns,
 * whatever role it plays (user, supplier employee, admin — those role
 * tables arrive with the tasks that own them, EPIC-02).
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

export type OtpChallengeStatus =
  "pending" | "active" | "consumed" | "superseded" | "expired" | "exhausted" | "failed";

/** `otp_challenge` (ARCHITECTURE 5.1, 8.1): one login code, stored as an HMAC. */
export const otpChallenge = pgTable("otp_challenge", {
  id: uuid("id").primaryKey().defaultRandom(),
  phone: text("phone").notNull(),
  purpose: text("purpose").$type<"login" | "phone_change">().notNull().default("login"),
  status: text("status").$type<OtpChallengeStatus>().notNull().default("pending"),
  channel: text("channel").$type<"whatsapp" | "sms">(),
  codeHash: text("code_hash").notNull(),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** `phone_verification`: the channel a phone number was last confirmed through. */
export const phoneVerification = pgTable("phone_verification", {
  phone: text("phone").primaryKey(),
  channel: text("channel").$type<"whatsapp" | "sms">().notNull(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SessionKindValue = "mobile" | "supplier_web" | "admin_web";

export type SessionRevokedReason =
  "logout" | "ended_by_owner" | "ended_others" | "ended_all" | "refresh_reuse";

/**
 * `session` (ARCHITECTURE 5.1, 8.2): one signed-in device or browser. No
 * token is stored — refresh tokens are derived from `refreshSeed` with the
 * server secret (see `session/session-tokens.ts`).
 */
export const session = pgTable("session", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => account.id),
  kind: text("kind").$type<SessionKindValue>().notNull(),
  supplierId: uuid("supplier_id"),
  supplierMemberId: uuid("supplier_member_id"),
  refreshSeed: text("refresh_seed").notNull(),
  refreshGeneration: integer("refresh_generation").notNull().default(0),
  refreshRotatedAt: timestamp("refresh_rotated_at", { withTimezone: true }),
  loginChallengeId: uuid("login_challenge_id"),
  clientPlatform: text("client_platform"),
  clientVersion: text("client_version"),
  deviceName: text("device_name"),
  lastIp: text("last_ip"),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  absoluteExpiresAt: timestamp("absolute_expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedReason: text("revoked_reason").$type<SessionRevokedReason>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Every table this module owns — checked against the migrated database. */
export const identityTables = [account, otpChallenge, phoneVerification, session];
