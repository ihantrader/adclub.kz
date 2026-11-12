import type {
  AssistantCarWords,
  AssistantComplaintReason,
  AssistantComplaintStatus,
  AssistantIntent,
  AssistantMessageKind,
  CatalogLanguage,
  CompatibilityVehicle,
} from "@adclub/contracts";
import { boolean, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { accountCar } from "../garage";
import { account, adminUser } from "../identity";
import { city } from "../suppliers";
import type { StoredReply, StoredToolCall } from "./assistant-types";

/**
 * The Drizzle mirror of `assistant_dialog`, `assistant_message` and
 * `assistant_complaint` (`infra/migrations/…_assistant.sql` — the source of
 * truth, with the checks; ARCHITECTURE 4.85).
 */
export const assistantDialog = pgTable("assistant_dialog", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").references(() => account.id, { onDelete: "cascade" }),
  deviceId: uuid("device_id"),
  language: text("language").$type<CatalogLanguage>().notNull(),
  vehicle: jsonb("vehicle").$type<CompatibilityVehicle>().notNull(),
  carWords: jsonb("car_words").$type<AssistantCarWords>().notNull(),
  carId: uuid("car_id").references(() => accountCar.id, { onDelete: "set null" }),
  cityId: uuid("city_id").references(() => city.id),
  turns: integer("turns").notNull().default(0),
  charged: boolean("charged").notNull().default(false),
  chargedAt: timestamp("charged_at", { withTimezone: true }),
  turnStartedAt: timestamp("turn_started_at", { withTimezone: true }),
  // The client's key of the new dialog (TASK-063.B): a lost answer's send sent again finds it.
  openKey: uuid("open_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
});

export type AssistantDialogRow = typeof assistantDialog.$inferSelect;

export const assistantMessage = pgTable("assistant_message", {
  id: uuid("id").primaryKey().defaultRandom(),
  dialogId: uuid("dialog_id")
    .notNull()
    .references(() => assistantDialog.id, { onDelete: "cascade" }),
  role: text("role").$type<"user" | "assistant">().notNull(),
  text: text("text"),
  kind: text("kind").$type<AssistantMessageKind>(),
  intent: text("intent").$type<AssistantIntent>(),
  itemIds: uuid("item_ids").array().notNull().default([]),
  foundItemIds: uuid("found_item_ids").array().notNull().default([]),
  droppedItems: integer("dropped_items").notNull().default(0),
  reply: jsonb("reply").$type<StoredReply>(),
  toolCalls: jsonb("tool_calls").$type<StoredToolCall[]>().notNull().default([]),
  aiJobIds: uuid("ai_job_ids").array().notNull().default([]),
  anonymizedAt: timestamp("anonymized_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AssistantMessageRow = typeof assistantMessage.$inferSelect;

export const assistantComplaint = pgTable("assistant_complaint", {
  id: uuid("id").primaryKey().defaultRandom(),
  messageId: uuid("message_id")
    .notNull()
    .references(() => assistantMessage.id, { onDelete: "cascade" }),
  dialogId: uuid("dialog_id")
    .notNull()
    .references(() => assistantDialog.id, { onDelete: "cascade" }),
  reason: text("reason").$type<AssistantComplaintReason>().notNull(),
  text: text("text"),
  status: text("status").$type<AssistantComplaintStatus>().notNull().default("new"),
  comment: text("comment"),
  resolvedBy: uuid("resolved_by").references(() => adminUser.id, { onDelete: "set null" }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AssistantComplaintRow = typeof assistantComplaint.$inferSelect;

export const assistantTables = [assistantDialog, assistantMessage, assistantComplaint];
