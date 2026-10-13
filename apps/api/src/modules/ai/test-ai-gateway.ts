import { Injectable } from "@nestjs/common";
import { rankCandidates } from "@adclub/domain";
import type { AiTestMode } from "../../config";
import {
  AiGateway,
  AiGatewayError,
  type AiResult,
  type PriceMatchInput,
  type PriceMatchRow,
  type ReviewCheckInput,
  type TranslateInput,
  type TranslateItem,
  type VehicleDocumentInput,
} from "./ai-gateway";
import { readSampleMarker, TEST_VEHICLE_DOCUMENTS } from "./test-vehicle-documents";

const TRANSLITERATION: Readonly<Record<string, string>> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "kh",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "shch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
};

function transliterate(text: string): string {
  let result = "";
  for (const char of text) {
    const lower = char.toLowerCase();
    const latin = TRANSLITERATION[lower];
    if (latin === undefined) {
      result += char;
    } else {
      result += char === lower ? latin : latin.charAt(0).toUpperCase() + latin.slice(1);
    }
  }
  return result;
}

/**
 * The text the test provider "translates" to: deterministic and plainly
 * not a real translation, so nobody mistakes it for one. Kazakh keeps the
 * Russian letters and English is the Russian text in Latin letters, each
 * with a marker (`Тормозные колодки [kk]`, `Tormoznye kolodki [en]`); the
 * text is cut so the result fits `maxLength`.
 */
export function testTranslation(text: string, lang: "kk" | "en", maxLength: number): string {
  const marker = ` [${lang}]`;
  const base = lang === "en" ? transliterate(text) : text;
  return base.slice(0, Math.max(1, maxLength - marker.length)).trimEnd() + marker;
}

/**
 * A model identifier the test provider refuses as unknown, so the
 * fallback of an operation (D-056) can be seen in development without a
 * key: set the primary model setting to `missing/anything`.
 */
export const MISSING_MODEL_PREFIX = "missing/";

/**
 * The words the test provider «finds» in a review (TASK-049), by the kind of
 * violation: deterministic and plainly a stand-in for a model — a text with
 * one of these words (as a word or its beginning, in any case) is reported
 * with that kind, anything else is clean. Criticism and a low score are
 * clean, as they must be for a real model too. Development, tests and CI.
 */
export const TEST_REVIEW_MARKERS = {
  profanity: ["дурак", "идиот", "мразь", "ақымақ", "idiot", "durak", "fuck"],
  threat: ["убью", "сожгу", "өлтіремін", "kill you", "ubyu"],
  personal_data: ["паспорт", "иин", "номер карты", "passport"],
  advertising: ["промокод", "подписывайтесь", "promo code", "заходите на канал"],
} as const;

function reviewMarkerFound(text: string, marker: string): boolean {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}`, "iu").test(text);
}

/**
 * Prices the test provider pretends its answers cost, USD per million
 * tokens. They are make-believe (nothing is called), and exist only so
 * that accounting and the daily budget are exercised with numbers of a
 * plausible size; real costs come from OpenRouter with every answer
 * (ARCHITECTURE 4.20 I188).
 */
const PRETEND_PRICE_PER_MILLION = { input: 1, output: 5 };

/**
 * The stand-in for the AI provider (development, tests and CI): calls
 * nothing, answers deterministically and can be made to fail, answer
 * slowly, leave part of a batch out or answer with texts the checks
 * refuse (`AI_TEST_MODE` sets the start mode; tests change `mode` and
 * `delayMs`, and `override` decides a single text). It reports plausible
 * usage and a cost, so accounting and the daily budget are exercised
 * exactly as with a real provider.
 */
@Injectable()
export class TestAiGateway extends AiGateway {
  readonly provider = "test" as const;
  /** What the next calls do. */
  mode: AiTestMode = "ok";
  /** How long a `slow` call takes, milliseconds. */
  delayMs = 5_000;
  /** Every request received, with the model it was asked of (tests look at what was sent). */
  readonly requests: { input: TranslateInput; model: string }[] = [];
  /** A text to answer with for one item and language instead of the default; `undefined` — the default. */
  override: ((item: TranslateItem, lang: "kk" | "en") => string | undefined) | undefined;
  /** Models the provider refuses, beyond `missing/…` (tests of the fallback). */
  failingModels = new Set<string>();
  /** Every certificate photo received: its size and the model, never the picture (TASK-057). */
  readonly documentRequests: { bytes: number; model: string }[] = [];
  /** Every batch of price list rows received: how many rows and the model (TASK-047). */
  readonly priceMatchRequests: { rows: number; model: string }[] = [];
  /** An answer for one row instead of the closest candidate; `undefined` — the default. */
  matchOverride:
    ((row: PriceMatchRow) => { itemId: string | null; confidence: number } | undefined) | undefined;

  async translate(input: TranslateInput, model: string, signal: AbortSignal): Promise<AiResult> {
    this.requests.push({ input, model });
    if (model.startsWith(MISSING_MODEL_PREFIX) || this.failingModels.has(model)) {
      throw new AiGatewayError("model_unavailable", `The test AI provider has no model ${model}`);
    }
    switch (this.mode) {
      case "unavailable":
        throw new AiGatewayError("unavailable", "The test AI provider is unavailable");
      case "rejected":
        throw new AiGatewayError("rejected", "The test AI provider refuses the request");
      case "no_private_provider":
        throw new AiGatewayError(
          "no_private_provider",
          "No provider of this model keeps requests unstored, so nothing was sent",
        );
      case "slow":
        await this.wait(this.delayMs, signal);
        break;
      default:
        break;
    }
    const translations = input.items.flatMap((item) =>
      item.languages.map((lang) => ({
        id: item.id,
        lang,
        text: this.override?.(item, lang) ?? this.textFor(item, lang),
      })),
    );
    // A provider that leaves part of the batch out: a temporary trouble, not an answer.
    const answered = this.mode === "incomplete" ? translations.slice(0, -1) : translations;
    const chars = (text: string) => Math.ceil(text.length / 4);
    const tokensIn =
      50 + input.items.reduce((sum, item) => sum + chars(item.text + item.context), 0);
    const tokensOut = answered.reduce((sum, item) => sum + chars(item.text) + 4, 0);
    const costUsd =
      (tokensIn * PRETEND_PRICE_PER_MILLION.input + tokensOut * PRETEND_PRICE_PER_MILLION.output) /
      1_000_000;
    return {
      output: { translations: answered },
      model,
      usage: {
        tokensIn,
        tokensOut,
        // `no_cost`: a provider that did not say what the call cost.
        costUsd: this.mode === "no_cost" ? null : Math.round(costUsd * 1_000_000) / 1_000_000,
      },
    };
  }

  /**
   * Reads a synthetic sample by its control strip (`test-vehicle-documents.ts`):
   * the fields of that sample, `unreadable` for a photo without a strip. The
   * photo is looked at and dropped — only its size is remembered, for tests.
   */
  async readVehicleDocument(
    input: VehicleDocumentInput,
    model: string,
    signal: AbortSignal,
  ): Promise<AiResult> {
    this.documentRequests.push({ bytes: input.image.length, model });
    if (model.startsWith(MISSING_MODEL_PREFIX) || this.failingModels.has(model)) {
      throw new AiGatewayError("model_unavailable", `The test AI provider has no model ${model}`);
    }
    switch (this.mode) {
      case "unavailable":
        throw new AiGatewayError("unavailable", "The test AI provider is unavailable");
      case "rejected":
        throw new AiGatewayError("rejected", "The test AI provider refuses the request");
      case "no_private_provider":
        throw new AiGatewayError(
          "no_private_provider",
          "No provider of this model keeps requests unstored, so nothing was sent",
        );
      case "slow":
        await this.wait(this.delayMs, signal);
        break;
      default:
        break;
    }
    const none = {
      make: null,
      model: null,
      year: null,
      vin: null,
      plate: null,
      engineVolumeCc: null,
      color: null,
    };
    let output: Record<string, unknown>;
    if (this.mode === "unreadable") {
      output = { documentKind: "unreadable", ...none };
    } else if (this.mode === "other_document") {
      output = { documentKind: "other_document", ...none };
    } else {
      const code = await readSampleMarker(input.image);
      const sample = code === null ? undefined : TEST_VEHICLE_DOCUMENTS[code];
      output = sample ? { ...sample } : { documentKind: "unreadable", ...none };
    }
    // A picture is about a thousand tokens for a vision model; the price is make-believe.
    const tokensIn = 1_100;
    const tokensOut = 80;
    const costUsd =
      (tokensIn * PRETEND_PRICE_PER_MILLION.input + tokensOut * PRETEND_PRICE_PER_MILLION.output) /
      1_000_000;
    return {
      output,
      model,
      usage: {
        tokensIn,
        tokensOut,
        costUsd: this.mode === "no_cost" ? null : Math.round(costUsd * 1_000_000) / 1_000_000,
      },
    };
  }

  /**
   * Matches each row with the candidate whose words are closest to it
   * (`candidateScore` of the domain): deterministic, and plainly a stand-in.
   * The best candidate scoring at least 0.5 is the answer with that score as
   * the confidence; anything less is «нет в справочнике». `matchOverride`
   * decides a single row instead (tests of the threshold and of «нет»).
   */
  async matchPrices(input: PriceMatchInput, model: string, signal: AbortSignal): Promise<AiResult> {
    this.priceMatchRequests.push({ rows: input.rows.length, model });
    if (model.startsWith(MISSING_MODEL_PREFIX) || this.failingModels.has(model)) {
      throw new AiGatewayError("model_unavailable", `The test AI provider has no model ${model}`);
    }
    switch (this.mode) {
      case "unavailable":
        throw new AiGatewayError("unavailable", "The test AI provider is unavailable");
      case "rejected":
        throw new AiGatewayError("rejected", "The test AI provider refuses the request");
      case "no_private_provider":
        throw new AiGatewayError(
          "no_private_provider",
          "No provider of this model keeps requests unstored, so nothing was sent",
        );
      case "slow":
        await this.wait(this.delayMs, signal);
        break;
      default:
        break;
    }
    const matches = input.rows.map((row) => {
      const decided = this.matchOverride?.(row);
      if (decided) {
        return { id: row.id, ...decided, explanation: "test: decided by the test" };
      }
      const ranked = rankCandidates(
        { name: row.name, brand: row.brand },
        row.candidates.map((candidate) => ({
          itemId: candidate.id,
          name: candidate.name,
          brandSpellings: candidate.brand ? [candidate.brand] : [],
          article: candidate.article,
        })),
        1,
      );
      const best = ranked[0];
      return best && best.score >= 0.5
        ? {
            id: row.id,
            itemId: best.candidate.itemId,
            confidence: Math.round(best.score * 1000) / 1000,
            explanation: `test: the closest candidate (${best.score.toFixed(2)})`,
          }
        : { id: row.id, itemId: null, confidence: 0.9, explanation: "test: none fits" };
    });
    const answered = this.mode === "incomplete" ? matches.slice(0, -1) : matches;
    const tokensIn = 60 + input.rows.length * 40;
    const tokensOut = answered.length * 20;
    const costUsd =
      (tokensIn * PRETEND_PRICE_PER_MILLION.input + tokensOut * PRETEND_PRICE_PER_MILLION.output) /
      1_000_000;
    return {
      output: { matches: answered },
      model,
      usage: {
        tokensIn,
        tokensOut,
        costUsd: this.mode === "no_cost" ? null : Math.round(costUsd * 1_000_000) / 1_000_000,
      },
    };
  }

  /** Every review text received: its length and the model, never the text (TASK-049). */
  readonly reviewCheckRequests: { chars: number; model: string }[] = [];

  /**
   * Reports a violation for each kind whose marker word the text has
   * (`TEST_REVIEW_MARKERS`); a text without them is clean. `incomplete` —
   * an answer that is not one at all for this operation (`invalid_output`).
   */
  async checkReview(
    input: ReviewCheckInput,
    model: string,
    signal: AbortSignal,
  ): Promise<AiResult> {
    this.reviewCheckRequests.push({ chars: input.text.length, model });
    if (model.startsWith(MISSING_MODEL_PREFIX) || this.failingModels.has(model)) {
      throw new AiGatewayError("model_unavailable", `The test AI provider has no model ${model}`);
    }
    switch (this.mode) {
      case "unavailable":
        throw new AiGatewayError("unavailable", "The test AI provider is unavailable");
      case "rejected":
        throw new AiGatewayError("rejected", "The test AI provider refuses the request");
      case "no_private_provider":
        throw new AiGatewayError(
          "no_private_provider",
          "No provider of this model keeps requests unstored, so nothing was sent",
        );
      case "slow":
        await this.wait(this.delayMs, signal);
        break;
      default:
        break;
    }
    const violations = Object.entries(TEST_REVIEW_MARKERS).flatMap(([kind, markers]) => {
      const found = markers.find((marker) => reviewMarkerFound(input.text, marker));
      return found ? [{ kind, explanation: `test: найдено «${found}»` }] : [];
    });
    const tokensIn = 120 + Math.ceil(input.text.length / 4);
    const tokensOut = 10 + violations.length * 20;
    const costUsd =
      (tokensIn * PRETEND_PRICE_PER_MILLION.input + tokensOut * PRETEND_PRICE_PER_MILLION.output) /
      1_000_000;
    return {
      output: this.mode === "incomplete" ? { found: violations } : { violations },
      model,
      usage: {
        tokensIn,
        tokensOut,
        costUsd: this.mode === "no_cost" ? null : Math.round(costUsd * 1_000_000) / 1_000_000,
      },
    };
  }

  private textFor(item: TranslateItem, lang: "kk" | "en"): string {
    switch (this.mode) {
      case "empty":
        return "";
      case "too_long":
        return "x".repeat(item.maxLength + 1);
      case "control_characters":
        return `${item.text.slice(0, 5)}\u0007${item.text.slice(5, 9)}`;
      case "wrong_language":
        // English that is still Russian; Kazakh that is only Latin letters.
        return lang === "en" ? item.text : "Wrong language text";
      default:
        return testTranslation(item.text, lang, item.maxLength);
    }
  }

  private wait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
