import {
  bigint,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

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
  | "logout"
  | "ended_by_owner"
  | "ended_others"
  | "ended_all"
  | "refresh_reuse"
  // The session lost its context (TASK-006).
  | "access_closed"
  | "admin_removed"
  | "totp_reset";

export type SupplierStatus = "draft" | "active" | "paused" | "blocked";

/**
 * `supplier` (ARCHITECTURE 5.5): a company, reduced to what the cabinet
 * sign-in needs. Owned here until the supplier module arrives (TASK-016).
 */
export const supplier = pgTable("supplier", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  city: text("city").notNull(),
  status: text("status").$type<SupplierStatus>().notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type MembershipStatus = "active" | "removed";

/** `supplier_member` (ARCHITECTURE 5.1, 8.3): an employee of a company. */
export const supplierMember = pgTable("supplier_member", {
  id: uuid("id").primaryKey().defaultRandom(),
  supplierId: uuid("supplier_id")
    .notNull()
    .references(() => supplier.id),
  accountId: uuid("account_id")
    .notNull()
    .references(() => account.id),
  displayName: text("display_name").notNull(),
  status: text("status").$type<MembershipStatus>().notNull().default("active"),
  role: text("role").$type<"member">().notNull().default("member"),
  permissions: jsonb("permissions"),
  addedBy: text("added_by").$type<"admin" | "member" | "operator">().notNull(),
  removedAt: timestamp("removed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * `admin_user` (ARCHITECTURE 5.1, 8.1): an administrator and their TOTP
 * second factor. `totpSecret` is encrypted (`admin/secret-box.ts`).
 */
export const adminUser = pgTable("admin_user", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => account.id),
  role: text("role").$type<"admin">().notNull().default("admin"),
  status: text("status").$type<MembershipStatus>().notNull().default("active"),
  totpSecret: text("totp_secret"),
  totpConfirmedAt: timestamp("totp_confirmed_at", { withTimezone: true }),
  totpLastUsedStep: bigint("totp_last_used_step", { mode: "number" }),
  removedAt: timestamp("removed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** `admin_backup_code`: one-time backup codes, as keyed hashes only. */
export const adminBackupCode = pgTable("admin_backup_code", {
  id: uuid("id").primaryKey().defaultRandom(),
  adminUserId: uuid("admin_user_id")
    .notNull()
    .references(() => adminUser.id),
  codeHash: text("code_hash").notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SignInStepKind = "supplier_selection" | "admin_totp_setup" | "admin_totp";

/**
 * `sign_in_step`: a sign-in whose login code is spent but whose next step
 * (company choice, second factor) is still due. Only a keyed hash of the
 * step token is stored.
 */
export const signInStep = pgTable("sign_in_step", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").$type<SignInStepKind>().notNull(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => account.id),
  adminUserId: uuid("admin_user_id").references(() => adminUser.id),
  tokenHash: text("token_hash").notNull(),
  // Keyed hash of the value in the step cookie of the client that passed the code.
  clientBindingHash: text("client_binding_hash"),
  totpSecret: text("totp_secret"),
  loginChallengeId: uuid("login_challenge_id"),
  clientPlatform: text("client_platform"),
  clientVersion: text("client_version"),
  deviceName: text("device_name"),
  ip: text("ip"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * `session` (ARCHITECTURE 5.1, 8.2): one signed-in device or browser. No
 * token is stored — refresh tokens are derived from `refreshSeed` with the
 * server secret (see `session/session-tokens.ts`).
 */
export const session = pgTable(
  "session",
  {
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
  },
  (table) => [
    // The employee belongs to the session's company.
    foreignKey({
      columns: [table.supplierMemberId, table.supplierId],
      foreignColumns: [supplierMember.id, supplierMember.supplierId],
      name: "session_supplier_member_fkey",
    }),
  ],
);

/** Every table this module owns — checked against the migrated database. */
export const identityTables = [
  account,
  otpChallenge,
  phoneVerification,
  session,
  supplier,
  supplierMember,
  adminUser,
  adminBackupCode,
  signInStep,
];
