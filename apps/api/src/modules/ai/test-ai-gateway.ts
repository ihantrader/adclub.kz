import { Injectable } from "@nestjs/common";
import type { AiTestMode } from "../../config";
import {
  AI_MODELS,
  AiGateway,
  AiGatewayError,
  type AiResult,
  type TranslateInput,
  type TranslateItem,
} from "./ai-gateway";
import { estimateCostUsd } from "./ai-pricing";

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
 * The stand-in for the AI provider (development, tests and CI): calls
 * nothing, answers deterministically and can be made to fail, answer
 * slowly or answer with texts the checks refuse (`AI_TEST_MODE` sets the
 * start mode; tests change `mode` and `delayMs`, and `override` decides a
 * single text). It reports plausible usage, so accounting and the daily
 * budget are exercised exactly as with a real provider.
 */
@Injectable()
export class TestAiGateway extends AiGateway {
  readonly provider = "test" as const;
  /** What the next calls do. */
  mode: AiTestMode = "ok";
  /** How long a `slow` call takes, milliseconds. */
  delayMs = 5_000;
  /** Every request received (tests look at what was sent). */
  readonly requests: TranslateInput[] = [];
  /** A text to answer with for one item and language instead of the default; `undefined` — the default. */
  override: ((item: TranslateItem, lang: "kk" | "en") => string | undefined) | undefined;

  async translate(input: TranslateInput, signal: AbortSignal): Promise<AiResult> {
    this.requests.push(input);
    switch (this.mode) {
      case "unavailable":
        throw new AiGatewayError("unavailable", "The test AI provider is unavailable");
      case "rejected":
        throw new AiGatewayError("rejected", "The test AI provider refuses the request");
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
    const chars = (text: string) => Math.ceil(text.length / 4);
    const tokensIn =
      50 + input.items.reduce((sum, item) => sum + chars(item.text + item.context), 0);
    const tokensOut = translations.reduce((sum, item) => sum + chars(item.text) + 4, 0);
    return {
      output: { translations },
      model: AI_MODELS.standard,
      usage: {
        tokensIn,
        tokensOut,
        costUsd: estimateCostUsd(AI_MODELS.standard, { tokensIn, tokensOut }),
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
