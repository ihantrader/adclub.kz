import { formatText, mobileText, pluralForm, type Lang, type MobileTextKey } from "@adclub/i18n";
import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { systemLanguage } from "../config/environment";
import { startLanguage } from "../start/start-decision";
import { languageStore } from "./stores";

/** Values a `{name}` placeholder of a dictionary text is filled with. */
export type TextParams = Readonly<Record<string, string | number>>;

/**
 * A word whose dictionary carries the three plural forms (the keys
 * `<name>.one`, `<name>.few` and `<name>.many`): `tn("catalog.offersCount", 3)`
 * picks the right one for the current language and fills `{n}` with the number.
 */
type PluralBaseOf<Key> = Key extends `${infer Base}.one` ? Base : never;

export type PluralKey = PluralBaseOf<MobileTextKey>;

/**
 * The interface language of the app: `@adclub/i18n` supplies the set of
 * languages, the texts and the fallback; this keeps the current one, changes
 * it from the profile and hands screens their `t()`.
 */
export interface LanguageContextValue {
  /** The language to render with. */
  lang: Lang;
  /** The choice kept on the device; `null` — never chosen. */
  chosen: Lang | null;
  /** The device language when it is kk/ru/en. */
  system: Lang | null;
  setLanguage: (lang: Lang) => void;
  /** A text of the dictionary in the current language, with `{name}` filled in. */
  t: (key: MobileTextKey, params?: TextParams) => string;
  /** A counted text in the right plural form; `{n}` is the count. */
  tn: (key: PluralKey, count: number, params?: TextParams) => string;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const chosen = useSyncExternalStore(languageStore.subscribe, languageStore.get);
  const lang = startLanguage(chosen, systemLanguage);

  const value = useMemo<LanguageContextValue>(() => {
    const t = (key: MobileTextKey, params?: TextParams) =>
      formatText(mobileText(lang, key), params);
    return {
      lang,
      chosen,
      system: systemLanguage,
      setLanguage: languageStore.set,
      t,
      tn: (key, count, params) =>
        t(`${key}.${pluralForm(lang, count)}` as MobileTextKey, { n: count, ...params }),
    };
  }, [chosen, lang]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage(): LanguageContextValue {
  const value = useContext(LanguageContext);
  if (!value) throw new Error("useLanguage must be used inside <LanguageProvider>");
  return value;
}

/** Screens take their texts from the dictionary, never from a string in the component. */
export function useT(): LanguageContextValue["t"] {
  return useLanguage().t;
}
