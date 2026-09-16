import en from "./locales/en.json";
import kk from "./locales/kk.json";
import ru from "./locales/ru.json";

export const locales = { en, kk, ru } as const;

export type Lang = keyof typeof locales;
export type TranslationKey = keyof (typeof locales)["ru"];

export const languages: Lang[] = ["kk", "ru", "en"];

export function translate(lang: Lang, key: TranslationKey): string {
  return locales[lang][key];
}
