import type { NotificationKind, PushPlatform, PushTargetValue } from "@adclub/contracts";
import { sql } from "drizzle-orm";
import { integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { account, session } from "../identity";
import { outboundMessage, type MessageTemplateKey } from "../messaging";
import type { PushChannelName, PushFailureKind } from "./push-provider";
import type { PushLang, PushTemplateCode } from "./push-templates";

/**
 * The Drizzle mirror of the push tables (`…_push-notifications.sql` — the
 * source of truth with the checks; ARCHITECTURE 5, 9.3, 4.79; TASK-051).
 */

export type DeviceTokenDeactivation = "session_ended" | "invalid_token" | "removed";

/** The platform's push token of one device, bound to the session that registered it. */
export const deviceToken = pgTable("device_token", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => account.id, { onDelete: "cascade" }),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => session.id, { onDelete: "cascade" }),
  platform: text("platform").$type<PushPlatform>().notNull(),
  /** Never written anywhere else whole: logs, the journal and pages show `maskToken`. */
  token: text("token").notNull(),
  deviceModel: text("device_model"),
  deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
  deactivatedReason: text("deactivated_reason").$type<DeviceTokenDeactivation>(),
  registeredAt: timestamp("registered_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type DeviceTokenRow = typeof deviceToken.$inferSelect;

export type NotificationStatus =
  | "queued"
  | "sent"
  | "no_device"
  | "failed"
  | "unknown"
  | "cancelled"
  /** A WhatsApp copy only: what the gateway's message became (TASK-052). */
  | "delivered"
  | "read";

/** What a notification opens and the values of its text. */
export interface NotificationPayload {
  target: PushTargetValue;
  variables: Record<string, string>;
  /**
   * The values of the WhatsApp copy when they differ from the push's: a
   * person reading English gets the Russian template (there are no English
   * WhatsApp templates), so its values are Russian too (TASK-052).
   */
  fallbackVariables?: Record<string, string>;
}

/** Why a push got no WhatsApp copy, or `sent` — it got one (TASK-052, `fallback-rule.ts`). */
export type FallbackDecisionValue =
  | "sent"
  | "not_critical"
  | "acked"
  | "superseded"
  | "not_current"
  | "stale"
  | "no_whatsapp"
  | "rate_limited"
  | "render_failed";

/** One notification to one person about one event (the journal of ARCHITECTURE 5). */
export const notification = pgTable("notification", {
  id: uuid("id").primaryKey().defaultRandom(),
  dedupeKey: text("dedupe_key").notNull(),
  recipientAccountId: uuid("recipient_account_id")
    .notNull()
    .references(() => account.id, { onDelete: "cascade" }),
  eventKind: text("event_kind").$type<NotificationKind>().notNull(),
  channel: text("channel").$type<"push" | "whatsapp">().notNull().default("push"),
  /** A push's code of `push-templates.ts`; a WhatsApp copy's key of `message-templates.ts`. */
  templateCode: text("template_code").$type<PushTemplateCode | MessageTemplateKey>().notNull(),
  /** A WhatsApp copy is `kk` or `ru` (there are no English WhatsApp templates). */
  lang: text("lang").$type<PushLang>().notNull(),
  payload: jsonb("payload").$type<NotificationPayload>().notNull(),
  subjectType: text("subject_type").notNull(),
  subjectId: uuid("subject_id"),
  status: text("status").$type<NotificationStatus>().notNull().default("queued"),
  providerMessageId: text("provider_message_id"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  ackedAt: timestamp("acked_at", { withTimezone: true }),
  /** TASK-052: the WhatsApp copy of a push nobody confirmed points at it. */
  fallbackOfId: uuid("fallback_of_id"),
  /** On a push: what became of its copy (`null` — not decided yet). */
  fallbackDecision: text("fallback_decision").$type<FallbackDecisionValue>(),
  fallbackDecidedAt: timestamp("fallback_decided_at", { withTimezone: true }),
  /** On a WhatsApp copy: the gateway's message. */
  outboundMessageId: uuid("outbound_message_id").references(() => outboundMessage.id, {
    onDelete: "set null",
  }),
  /** The moment of the insert (`clock_timestamp()`): «a later push» is decided by it (TASK-052). */
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`clock_timestamp()`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type NotificationRow = typeof notification.$inferSelect;

/**
 * How many critical pushes to a person in a row went unconfirmed past the
 * timeout (TASK-052): `push_unreliable` is this reaching
 * `push_unreliable_after`; any confirmation resets it. Changed only here.
 */
export const notificationRecipientState = pgTable("notification_recipient_state", {
  accountId: uuid("account_id")
    .primaryKey()
    .references(() => account.id, { onDelete: "cascade" }),
  unackedStreak: integer("unacked_streak").notNull().default(0),
  unackedSince: timestamp("unacked_since", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type DeliveryStatus = "queued" | "sending" | "sent" | "failed" | "unknown" | "cancelled";

/** A notification sent to one device. */
export const notificationDelivery = pgTable("notification_delivery", {
  id: uuid("id").primaryKey().defaultRandom(),
  notificationId: uuid("notification_id")
    .notNull()
    .references(() => notification.id, { onDelete: "cascade" }),
  deviceTokenId: uuid("device_token_id").references(() => deviceToken.id, {
    onDelete: "set null",
  }),
  tokenMask: text("token_mask").notNull(),
  platform: text("platform").$type<PushPlatform>().notNull(),
  status: text("status").$type<DeliveryStatus>().notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(5),
  claimedUntil: timestamp("claimed_until", { withTimezone: true }),
  provider: text("provider").$type<PushChannelName>(),
  providerMessageId: text("provider_message_id"),
  failureKind: text("failure_kind").$type<PushFailureKind | "render_failed">(),
  lastError: text("last_error"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  settledAt: timestamp("settled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type NotificationDeliveryRow = typeof notificationDelivery.$inferSelect;

/** Every table this module owns — checked against the migrated database. */
export const notificationTables = [
  deviceToken,
  notification,
  notificationDelivery,
  notificationRecipientState,
];
