import { z } from "zod";
import type { AiProviderName } from "../../config";
import type { SettingKey } from "../settings";

/**
 * The internal interface to AI (ARCHITECTURE 9.6, 4.19, 4.20; TASK-012,
 * TASK-053) and the pattern every later use follows (price matching, the
 * assistant, document recognition — each its own task):
 *
 * 1. an operation is a method of `AiGateway` with a zod schema for what it
 *    returns, and an entry in `AiOperation` (kind, the settings that hold
 *    its models, schema) — that is all a use adds;
 * 2. modules never call `AiGateway` directly: they call `AiService`, which
 *    reserves the call against the daily budget, picks the model of the
 *    operation from the settings (the fallback when the first one can't be
 *    reached), records the call in `ai_job`, cuts a call that takes too
 *    long, checks the answer against the operation's schema and classifies
 *    failures — so no implementation can forget accounting, and the checks
 *    are the same for every provider;
 * 3. implementations (`TestAiGateway`, `OpenRouterAiGateway`) only talk to
 *    their provider: they return the raw structured answer with the usage
 *    the provider reported and raise `AiGatewayError` with the right `kind`.
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

/**
 * What a provider reported for one call. `costUsd` is what the provider
 * says the call cost (D-055: OpenRouter reports it with the answer);
 * `null` — the provider did not say, and the caller must not read that as
 * free (`AiService` keeps the reservation instead, ARCHITECTURE 4.20 I188).
 */
export interface AiUsage {
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
}

/** A provider's answer: the structured output, not yet checked, and what it cost. */
export interface AiResult {
  output: unknown;
  /** The model that actually answered, as the provider names it. */
  model: string;
  usage: AiUsage;
}

/**
 * Why a call failed, which decides what happens to the work:
 * - `unavailable` — the provider can't be reached now, is overloaded or
 *   limits us: try again later;
 * - `model_unavailable` — this model is unknown, withdrawn or has no
 *   endpoint that can serve the request: retrying the same model can't
 *   help, but the fallback model may (TASK-053 requirement 2);
 * - `no_private_provider` — no provider of this model keeps requests
 *   unstored and untrained-on, so the request was not made at all
 *   (D-057): neither this model nor a retry will do, a person decides;
 * - `rejected` — the provider refuses the request for good (bad key,
 *   forbidden, malformed request): retrying can't help;
 * - `invalid_output` — the answer doesn't match the schema of the
 *   operation: a retry may give a good one;
 * - `not_configured` — no provider is set up for this.
 */
export type AiFailureKind =
  | "unavailable"
  | "model_unavailable"
  | "no_private_provider"
  | "rejected"
  | "invalid_output"
  | "not_configured";

/** Failures after which the fallback model of the operation is worth trying (D-056). */
export const FALLBACK_WORTHY: readonly AiFailureKind[] = ["unavailable", "model_unavailable"];

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
 * The provider behind the interface. `model` is the one `AiService` chose
 * from the settings of the operation; `signal` is aborted when the call
 * takes longer than `AiService` allows.
 */
export abstract class AiGateway {
  abstract readonly provider: AiProviderName;

  abstract translate(input: TranslateInput, model: string, signal: AbortSignal): Promise<AiResult>;
}

/**
 * Which settings hold the models of an operation (D-056): both are
 * changed without a release, and the fallback is used when the first one
 * can't answer. The same model in both means there is no fallback.
 */
export interface AiOperationModels {
  primary: SettingKey;
  fallback: SettingKey;
}

/**
 * What `AiService` needs to know to run one operation on a gateway: how it
 * is recorded, where its models come from, how its answer is checked and
 * how it is called.
 */
export interface AiOperation<Input, Output> {
  kind: AiJobKind;
  models: AiOperationModels;
  outputSchema: z.ZodType<Output>;
  invoke(gateway: AiGateway, input: Input, model: string, signal: AbortSignal): Promise<AiResult>;
}

export const translateOperation: AiOperation<TranslateInput, TranslateOutput> = {
  kind: "translate",
  models: { primary: "ai_model_translate_primary", fallback: "ai_model_translate_fallback" },
  outputSchema: translateOutputSchema,
  invoke: (gateway, input, model, signal) => gateway.translate(input, model, signal),
};
