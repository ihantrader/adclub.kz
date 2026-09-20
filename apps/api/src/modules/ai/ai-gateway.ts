import { z } from "zod";
import type { AiProviderName } from "../../config";

/**
 * The internal interface to AI (ARCHITECTURE 9.6, 4.19; TASK-012) and the
 * pattern every later use follows (price matching, the assistant, document
 * recognition — each its own task):
 *
 * 1. an operation is a method of `AiGateway` with a zod schema for what it
 *    returns, and an entry in `AiOperation` (kind, model, schema) — that is
 *    all a use adds;
 * 2. modules never call `AiGateway` directly: they call `AiService`, which
 *    checks the daily budget, writes the `ai_job` record of the call, cuts
 *    a call that takes too long, checks the answer against the operation's
 *    schema and classifies failures — so no implementation can forget
 *    accounting, and the checks are the same for every provider;
 * 3. implementations (`TestAiGateway`, `ClaudeAiGateway`) only talk to their
 *    provider: they return the raw structured answer with the usage the
 *    provider reported and raise `AiGatewayError` with the right `kind`.
 */

/** Kinds of AI calls, as `ai_job.kind` (ARCHITECTURE 5.12). */
export type AiJobKind =
  | "price_columns"
  | "price_match"
  | "translate"
  | "compat_check"
  | "passport_ocr"
  | "dashboard_ocr"
  | "part_photo"
  | "assistant_turn"
  | "photo_search"
  | "attr_fill";

/** Models by task (ARCHITECTURE 9.6). */
export const AI_MODELS = {
  /** Translation of the catalog, column recognition, documents, photos. */
  standard: "claude-sonnet-5",
  /** Matching, compatibility, the assistant. */
  advanced: "claude-opus-5",
  /** Classification and simple checks. */
  light: "claude-haiku-4-5",
} as const;

/** What a provider reported for one call; `costUsd` — only if it (or its price list) can tell. */
export interface AiUsage {
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
}

/** A provider's answer: the structured output, not yet checked, and what it cost. */
export interface AiResult {
  output: unknown;
  model: string;
  usage: AiUsage;
}

/**
 * Why a call failed, which decides what happens to the work:
 * - `unavailable` — the provider can't be reached now, is overloaded or
 *   limits us: try again later;
 * - `rejected` — the provider refuses the request for good (bad key,
 *   forbidden, malformed request): retrying can't help;
 * - `invalid_output` — the answer doesn't match the schema of the
 *   operation: a retry may give a good one;
 * - `not_configured` — no provider is set up for this.
 */
export type AiFailureKind = "unavailable" | "rejected" | "invalid_output" | "not_configured";

/** A failed call. `message` is safe for a log: no request or answer content. */
export class AiGatewayError extends Error {
  constructor(
    readonly kind: AiFailureKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AiGatewayError";
  }
}

/** The day's spend has reached `ai_daily_budget_usd`: nothing is sent until the next day. */
export class AiBudgetExhaustedError extends Error {
  constructor(
    readonly spentUsd: number,
    readonly budgetUsd: number,
  ) {
    super(`The daily AI budget is exhausted (spent $${spentUsd.toFixed(4)} of $${budgetUsd})`);
    this.name = "AiBudgetExhaustedError";
  }
}

// ---------------------------------------------------------------- translate

/** A text to translate. `id` is the caller's own (unique in the request). */
export interface TranslateItem {
  id: string;
  /** The Russian text. */
  text: string;
  /** What the text is, to translate it in its sense ("name of a product category"). */
  context: string;
  /** The translation must not be longer than this, in characters. */
  maxLength: number;
  /** The languages this text is wanted in. */
  languages: readonly ("kk" | "en")[];
}

export interface TranslateInput {
  items: readonly TranslateItem[];
}

/** One translation: the item, the language and the text. */
export const translateOutputSchema = z.object({
  translations: z.array(
    z.object({
      id: z.string(),
      lang: z.enum(["kk", "en"]),
      text: z.string(),
    }),
  ),
});

export type TranslateOutput = z.infer<typeof translateOutputSchema>;

/**
 * The provider behind the interface. `signal` is aborted when the call takes
 * longer than `AiService` allows.
 */
export abstract class AiGateway {
  abstract readonly provider: AiProviderName;

  abstract translate(input: TranslateInput, signal: AbortSignal): Promise<AiResult>;
}

/**
 * What `AiService` needs to know to run one operation on a gateway: how it
 * is recorded, the model, how its answer is checked and how it is called.
 */
export interface AiOperation<Input, Output> {
  kind: AiJobKind;
  /** The model recorded for a failed call (a successful one records what the provider reports). */
  model: string;
  outputSchema: z.ZodType<Output>;
  invoke(gateway: AiGateway, input: Input, signal: AbortSignal): Promise<AiResult>;
}

export const translateOperation: AiOperation<TranslateInput, TranslateOutput> = {
  kind: "translate",
  model: AI_MODELS.standard,
  outputSchema: translateOutputSchema,
  invoke: (gateway, input, signal) => gateway.translate(input, signal),
};
