import { mobileText, type Lang, type MobileTextKey } from "@adclub/i18n";
import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { systemLanguage } from "../config/environment";
import { startLanguage } from "../start/start-decision";
import { languageStore } from "./stores";

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
  /** A text of the dictionary in the current language. */
  t: (key: MobileTextKey) => string;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const chosen = useSyncExternalStore(languageStore.subscribe, languageStore.get);
  const lang = startLanguage(chosen, systemLanguage);

  const value = useMemo<LanguageContextValue>(
    () => ({
      lang,
      chosen,
      system: systemLanguage,
      setLanguage: languageStore.set,
      t: (key) => mobileText(lang, key),
    }),
    [chosen, lang],
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage(): LanguageContextValue {
  const value = useContext(LanguageContext);
  if (!value) throw new Error("useLanguage must be used inside <LanguageProvider>");
  return value;
}

/** Screens take their texts from the dictionary, never from a string in the component. */
export function useT(): (key: MobileTextKey) => string {
  return useLanguage().t;
}
