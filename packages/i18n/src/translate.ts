import en from "./locales/en.json";
import kk from "./locales/kk.json";
import ru from "./locales/ru.json";

export const locales = { en, kk, ru } as const;

export type Lang = keyof typeof locales;
export type TranslationKey = keyof (typeof locales)["ru"];

export const languages: Lang[] = ["kk", "ru", "en"];

export const defaultLanguage: Lang = "ru";

export function isLang(value: string): value is Lang {
  return (languages as string[]).includes(value);
}

export function translate(lang: Lang, key: TranslationKey): string {
  return locales[lang][key];
}

/**
 * Picks the best supported language from an `Accept-Language` header
 * (ARCHITECTURE 7.1), honouring `q` weights and region subtags
 * (`kk-KZ` → `kk`). Falls back to Russian for a missing, malformed or
 * fully unsupported header.
 */
export function pickLanguage(acceptLanguage: string | null | undefined): Lang {
  if (!acceptLanguage) {
    return defaultLanguage;
  }

  const candidates = acceptLanguage
    .split(",")
    .map((part, index) => {
      const [tag = "", ...params] = part.trim().split(";");
      const qParam = params.map((param) => param.trim()).find((param) => param.startsWith("q="));
      const q = qParam === undefined ? 1 : Number(qParam.slice(2));
      return {
        lang: tag.trim().toLowerCase().split("-")[0] ?? "",
        q: Number.isFinite(q) ? q : 0,
        index,
      };
    })
    .filter((candidate) => candidate.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);

  for (const candidate of candidates) {
    if (isLang(candidate.lang)) {
      return candidate.lang;
    }
  }
  return defaultLanguage;
}
