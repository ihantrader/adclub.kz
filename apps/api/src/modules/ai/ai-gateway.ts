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
  | "attr_fill"
  | "review_check";

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

/**
 * Failures the provider decides before any model runs, so the call cost
 * nothing at all: OpenRouter refuses routing and nothing is served
 * (TASK-053.A). The day must not be charged the reservation for them —
 * a wrong model name would otherwise eat a daily budget through retries
 * alone and stop the work that does cost money. Everything else keeps the
 * reservation: a timeout, a 5xx or a refusal may still have been billed.
 */
export const NOT_BILLED: readonly AiFailureKind[] = [
  "model_unavailable",
  "no_private_provider",
  "not_configured",
];

/**
 * A failed call. `message` is safe for a log: no request or answer
 * content. `usage` is set when the provider did answer and the answer
 * turned out unusable — it was still charged for, and the day's budget
 * must count what it really cost instead of the reservation (TASK-053.A).
 */
export class AiGatewayError extends Error {
  readonly usage: AiUsage | undefined;

  constructor(
    readonly kind: AiFailureKind,
    message: string,
    options?: ErrorOptions & { usage?: AiUsage },
  ) {
    super(message, options);
    this.name = "AiGatewayError";
    this.usage = options?.usage;
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

/**
 * One term the translation must use as given (TASK-053.B requirement 5):
 * the Russian term and what it is called in each language. A short list
 * of them travels with the texts, so the same term is not called two
 * things in two names and an industry word is not replaced by an everyday
 * one. It is data (`translate-glossary.json`), not code.
 */
export interface TranslateGlossaryEntry {
  ru: string;
  kk?: string;
  en?: string;
}

export interface TranslateInput {
  items: readonly TranslateItem[];
  /** Terms to keep to; absent or empty — nothing is sent about terms. */
  glossary?: readonly TranslateGlossaryEntry[];
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

// ------------------------------------------------- vehicle document (OCR)

/**
 * A photo of a vehicle registration certificate to read (TASK-057, D-064):
 * already made smaller and stripped of metadata by the server. It lives in
 * memory for this one call — no gateway keeps it, logs it or writes it
 * anywhere (`AiService` records only its size in `ai_job.input_ref`).
 */
export interface VehicleDocumentInput {
  image: Uint8Array;
  contentType: "image/jpeg";
}

/**
 * What the model answers about the photo. Only the fields the garage needs:
 * the owner, the address, the series and the number of the certificate are
 * not in the schema at all, so a strict answer cannot carry them, and
 * whatever a provider adds anyway is dropped when the answer is checked
 * (a zod object keeps only its own keys).
 *
 * `documentKind`: `kz_registration` — a Kazakhstan vehicle registration
 * certificate, old or new form; `other_document` — a document of another
 * kind or country; `not_document` — not a document at all; `unreadable` —
 * a document that can't be read. Values are copied as written; a field
 * that is not clearly legible is `null`, never a guess.
 */
export const vehicleDocumentOutputSchema = z.object({
  documentKind: z.enum(["kz_registration", "other_document", "not_document", "unreadable"]),
  make: z.string().nullable(),
  model: z.string().nullable(),
  year: z.number().int().nullable(),
  vin: z.string().nullable(),
  plate: z.string().nullable(),
  engineVolumeCc: z.number().int().nullable(),
  color: z.string().nullable(),
});

export type VehicleDocumentOutput = z.infer<typeof vehicleDocumentOutputSchema>;

// ----------------------------------------------------- price list matching

/** A catalog item a row may be: what the model is shown of it. */
export interface PriceMatchCandidate {
  /** The caller's id of the candidate (the item's id). */
  id: string;
  name: string;
  brand: string | null;
  article: string | null;
  /** The subcategory, for the sense of the name. */
  category: string;
}

/**
 * A row of a supplier's price list to match (TASK-047): what the file says
 * of it and one to three candidates found by the search. Prices,
 * quantities and the company are not sent — the model needs only what
 * tells one item from another.
 */
export interface PriceMatchRow {
  id: string;
  article: string | null;
  brand: string | null;
  name: string | null;
  candidates: readonly PriceMatchCandidate[];
}

export interface PriceMatchInput {
  rows: readonly PriceMatchRow[];
}

/**
 * For each row: the candidate it is (`itemId`, one of the row's
 * candidates) or `null` — none of them, the catalog has no such item; how
 * sure the model is (0…1) and a short explanation the supplier sees.
 */
export const priceMatchOutputSchema = z.object({
  matches: z.array(
    z.object({
      id: z.string(),
      itemId: z.string().nullable(),
      // No bounds in the schema: strict structured output of some endpoints
      // refuses `minimum`/`maximum`; the caller keeps it within 0…1.
      confidence: z.number(),
      explanation: z.string(),
    }),
  ),
});

export type PriceMatchOutput = z.infer<typeof priceMatchOutputSchema>;

// ---------------------------------------------------------- review check

/**
 * The text of a review to check before it is published (TASK-049; PRODUCT
 * 13): the text and the score only — no name of the author, the supplier or
 * the order. The deterministic rules (contacts, the supplier's name, names of
 * employees) run before and AI is not asked when they find anything.
 */
export interface ReviewCheckInput {
  text: string;
  /** 1–5: a low score is no violation, and the model is told so. */
  score: number;
}

/**
 * The violations found, each of a kind from the fixed list and with a short
 * explanation for the administrator; empty — none. Criticism and a low score
 * are never violations. AI never refuses a review: a violation only holds it
 * for a person.
 */
export const reviewCheckOutputSchema = z.object({
  violations: z.array(
    z.object({
      kind: z.enum(["profanity", "threat", "personal_data", "advertising"]),
      explanation: z.string(),
    }),
  ),
});

export type ReviewCheckOutput = z.infer<typeof reviewCheckOutputSchema>;

/**
 * The provider behind the interface. `model` is the one `AiService` chose
 * from the settings of the operation; `signal` is aborted when the call
 * takes longer than `AiService` allows.
 */
export abstract class AiGateway {
  abstract readonly provider: AiProviderName;

  abstract translate(input: TranslateInput, model: string, signal: AbortSignal): Promise<AiResult>;

  abstract readVehicleDocument(
    input: VehicleDocumentInput,
    model: string,
    signal: AbortSignal,
  ): Promise<AiResult>;

  abstract matchPrices(
    input: PriceMatchInput,
    model: string,
    signal: AbortSignal,
  ): Promise<AiResult>;

  abstract checkReview(
    input: ReviewCheckInput,
    model: string,
    signal: AbortSignal,
  ): Promise<AiResult>;
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

/** Reading a registration certificate (TASK-057): `ai_job.kind` is `passport_ocr` (ARCHITECTURE 5.12). */
export const vehicleDocumentOperation: AiOperation<VehicleDocumentInput, VehicleDocumentOutput> = {
  kind: "passport_ocr",
  models: {
    primary: "ai_model_vehicle_document_primary",
    fallback: "ai_model_vehicle_document_fallback",
  },
  outputSchema: vehicleDocumentOutputSchema,
  invoke: (gateway, input, model, signal) => gateway.readVehicleDocument(input, model, signal),
};

/** Matching price list rows with catalog candidates (TASK-047): `ai_job.kind` is `price_match`. */
export const priceMatchOperation: AiOperation<PriceMatchInput, PriceMatchOutput> = {
  kind: "price_match",
  models: { primary: "ai_model_price_match_primary", fallback: "ai_model_price_match_fallback" },
  outputSchema: priceMatchOutputSchema,
  invoke: (gateway, input, model, signal) => gateway.matchPrices(input, model, signal),
};

/** Checking the text of a review before it is published (TASK-049): `ai_job.kind` is `review_check`. */
export const reviewCheckOperation: AiOperation<ReviewCheckInput, ReviewCheckOutput> = {
  kind: "review_check",
  models: { primary: "ai_model_review_check_primary", fallback: "ai_model_review_check_fallback" },
  outputSchema: reviewCheckOutputSchema,
  invoke: (gateway, input, model, signal) => gateway.checkReview(input, model, signal),
};
