import { Injectable } from "@nestjs/common";
import type { AiTestMode } from "../../config";
import {
  AiGateway,
  AiGatewayError,
  type AiResult,
  type TranslateInput,
  type TranslateItem,
} from "./ai-gateway";

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
