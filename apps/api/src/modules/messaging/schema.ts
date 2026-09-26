import { integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { MessageProviderName } from "../../config";
import type { MessageFailureKind } from "./message-channel";
import type { MessageLang, MessageTemplateKey } from "./message-templates";

/**
 * The Drizzle mirror of the messaging tables
 * (`…_create-messaging.sql` — the source of truth with the checks;
 * ARCHITECTURE 5.11, 4.35; TASK-024).
 */

/**
 * How far a message got. `queued` → `sending` (one attempt holds it) →
 * `sent` (the provider took it) → `delivered` → `read`, as the provider
 * reports; `failed` — the provider refused it or reported a failure;
 * `cancelled` — the event it belonged to no longer applies (the employee
 * was removed before it went out); `unknown` — an attempt was interrupted
 * while sending and nobody can say whether the provider got it, so nothing
 * is sent again by itself.
 *
 * The delivery order is never guaranteed (TASK-024 requirement 4): the
 * status only ever moves forward (`messageStatusRank`).
 */
export type MessageStatus =
  "queued" | "sending" | "sent" | "delivered" | "read" | "failed" | "cancelled" | "unknown";

/**
 * `outbound_message` — one message to one recipient. `dedupe_key` is what
 * makes "one event, one person, one message" true whatever the queue does:
 * the key is unique, so a repeated job and two workers at once write the
 * same row.
 */
export const outboundMessage = pgTable("outbound_message", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** `<subject type>:<subject id>[:<extra>]` — one per event and recipient. */
  dedupeKey: text("dedupe_key").notNull(),
  template: text("template").$type<MessageTemplateKey>().notNull(),
  lang: text("lang").$type<MessageLang>().notNull(),
  /** E.164, as the project stores numbers. */
  phone: text("phone").notNull(),
  /** What the message is about, so a module can own it without messaging knowing it. */
  subjectType: text("subject_type").notNull(),
  subjectId: uuid("subject_id"),
  /**
   * The values of the template's placeholders. Kept only while the message
   * still has to be sent (a retry after a restart needs them) and cleared
   * in the same transaction that settles it: a message carries a customer's
   * name and number (W-02), and there is no reason to keep those in a
   * delivery log (ARCHITECTURE 4.35).
   */
  variables: jsonb("variables").$type<Record<string, string>>(),
  /**
   * The payload of each quick reply, by the button's name (TASK-025): our
   * own signed tokens — an order, an employee, an expiry — sent with the
   * message so that a press tells the server exactly what it answers.
   */
  buttonPayloads: jsonb("button_payloads").$type<Record<string, string>>(),
  status: text("status").$type<MessageStatus>().notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  /**
   * How many attempts this message may have before it is `failed` — the
   * setting `message_send_attempts` as it was when the message was queued (or
   * brought back by the operator). The handler, not the queue, decides that
   * the attempts are spent: it settles the message on its last one, so a
   * message is never left `queued` with its values for good.
   */
  maxAttempts: integer("max_attempts").notNull().default(5),
  /** While this is in the future, the attempt that claimed the message holds it. */
  claimedUntil: timestamp("claimed_until", { withTimezone: true }),
  provider: text("provider").$type<MessageProviderName>(),
  /** The provider's id (`wamid.…`); delivery events arrive with it. */
  providerMessageId: text("provider_message_id"),
  failureKind: text("failure_kind").$type<MessageFailureKind | "render_failed">(),
  /** A short token or the provider's own words; never the text or a number. */
  lastError: text("last_error"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  readAt: timestamp("read_at", { withTimezone: true }),
  /** When the message stopped needing anything: sent, failed or cancelled. */
  settledAt: timestamp("settled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type OutboundMessageRow = typeof outboundMessage.$inferSelect;

/**
 * `inbound_webhook_event` — one delivery of the provider's webhook
 * (ARCHITECTURE 5.11). `external_id` is the digest of the body the
 * provider signed: it repeats a delivery byte for byte when it did not get
 * a 200, so the unique key is what makes the receipt idempotent.
 */
export const inboundWebhookEvent = pgTable("inbound_webhook_event", {
  id: uuid("id").primaryKey().defaultRandom(),
  provider: text("provider").$type<"whatsapp">().notNull(),
  externalId: text("external_id").notNull(),
  /** The body as sent; cleared as soon as it has been applied (see `variables`). */
  payload: jsonb("payload"),
  /** What the event turned out to hold: kinds and how many of each. */
  summary: jsonb("summary").$type<Record<string, number>>().notNull().default({}),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  /**
   * `applied` — something of ours changed; `nothing_to_apply` — the event
   * was sound but was about nothing we have (or of a kind we don't act on),
   * which is a 200 all the same; `failed` — applying it failed and the job
   * will try again.
   */
  result: text("result").$type<"applied" | "nothing_to_apply" | "failed">(),
  error: text("error"),
});

export type InboundWebhookEventRow = typeof inboundWebhookEvent.$inferSelect;

/**
 * What was decided about a press (TASK-025): `accepted`, `declined` — the
 * order moved; `repeated` — the same employee had already made that move;
 * `conflict` — the order had moved on, nothing changed; `member_removed` —
 * the employee is no longer one; `invalid_payload`, `expired`,
 * `phone_mismatch`, `foreign_message` — the press is not authentic enough
 * to act on; `no_handler` — no module acts on this button.
 */
export type ButtonPressOutcome =
  | "accepted"
  | "declined"
  | "repeated"
  | "conflict"
  | "member_removed"
  | "invalid_payload"
  | "expired"
  | "phone_mismatch"
  | "foreign_message"
  | "no_handler";

/**
 * `message_button_press` — a recipient tapped a button of a template
 * message. Stored and linked to the message by the webhook (TASK-024), then
 * dealt with by the worker (`messaging.apply-button-press`, TASK-025): the
 * module that owns the button decides, and `applied_at` with `outcome`
 * say when and how. Messaging itself never acts on an order.
 */
export const messageButtonPress = pgTable("message_button_press", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: uuid("event_id")
    .notNull()
    .references(() => inboundWebhookEvent.id, { onDelete: "cascade" }),
  /** The message the button belongs to; `null` — we have no such message. */
  messageId: uuid("message_id").references(() => outboundMessage.id),
  /** The provider's id of the incoming message: unique, so a replay adds nothing. */
  providerMessageId: text("provider_message_id").notNull(),
  /** The provider's id of the template message the press answers. */
  contextProviderMessageId: text("context_provider_message_id"),
  /** Our own name of the button, when the payload says which it was. */
  buttonName: text("button_name"),
  /** The payload of the quick reply, as sent: our own token, not the person's words. */
  payload: text("payload"),
  fromPhone: text("from_phone").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  /** When it was dealt with (TASK-025); `null` — not yet. */
  appliedAt: timestamp("applied_at", { withTimezone: true }),
  /** How it was dealt with (TASK-025): applied, or why not — set together with `applied_at`. */
  outcome: text("outcome").$type<ButtonPressOutcome>(),
});

export type MessageButtonPressRow = typeof messageButtonPress.$inferSelect;

/** Every table this module owns — checked against the migrated database. */
export const messagingTables = [outboundMessage, inboundWebhookEvent, messageButtonPress];
