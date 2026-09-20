import { integer, jsonb, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { AiProviderName } from "../../config";
import type { AiFailureKind, AiJobKind } from "./ai-gateway";

/**
 * Drizzle mirror of `ai_job` (`infra/migrations/…_create-ai-jobs-and-translation-tasks.sql`
 * — the source of truth; ARCHITECTURE 5.12, 4.19): one row per call to the
 * AI provider.
 */
export const aiJob = pgTable("ai_job", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").$type<AiJobKind>().notNull(),
  provider: text("provider").$type<AiProviderName>().notNull(),
  model: text("model").notNull(),
  initiatorType: text("initiator_type").$type<"system" | "account" | "guest_device">().notNull(),
  initiatorId: uuid("initiator_id"),
  inputRef: jsonb("input_ref").$type<Record<string, unknown>>().notNull().default({}),
  output: jsonb("output"),
  status: text("status").$type<"running" | "succeeded" | "failed">().notNull(),
  errorKind: text("error_kind").$type<AiFailureKind>(),
  error: text("error"),
  tokensIn: integer("tokens_in"),
  tokensOut: integer("tokens_out"),
  costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
  latencyMs: integer("latency_ms"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export type AiJobRow = typeof aiJob.$inferSelect;

export const aiTables = [aiJob];
