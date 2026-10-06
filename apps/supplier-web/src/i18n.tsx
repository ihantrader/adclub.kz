import type { Lang } from "@adclub/i18n";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { setApiLanguage } from "./api";
import { storedLanguage, storeLanguage } from "./prefs";
import { createTranslate, type Translate } from "./translate";

export type { Translate } from "./translate";

/** Keys already reported as missing in this page (development only). */
const warnedKeys = new Set<string>();
const warnMissing = import.meta.env.DEV ? (message: string) => console.warn(message) : null;

interface LanguageContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: Translate;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

/** The interface language (kk/ru/en): kept in this browser, sent to the API as `Accept-Language`. */
export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(storedLanguage);

  // Before the first request of the page, not after its first paint.
  setApiLanguage(lang);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const value = useMemo<LanguageContextValue>(
    () => ({
      lang,
      setLang(next) {
        storeLanguage(next);
        setLangState(next);
      },
      t: createTranslate(lang, warnMissing, warnedKeys),
    }),
    [lang],
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage(): LanguageContextValue {
  const value = useContext(LanguageContext);
  if (!value) throw new Error("useLanguage must be used inside <LanguageProvider>");
  return value;
}

export function useT(): Translate {
  return useLanguage().t;
}
