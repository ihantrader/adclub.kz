import { hasSupplierText, supplierText, type Lang, type SupplierTextKey } from "@adclub/i18n";

export type Translate = (
  key: SupplierTextKey,
  params?: Readonly<Record<string, string | number>>,
) => string;

/**
 * The cabinet's `t` for a language. A key the dictionary does not know (a
 * code built from a server value, a text not added yet) shows itself
 * instead of taking the page down; in development it is also reported in
 * the console, once per key, so it is noticed before the release.
 */
export function createTranslate(
  lang: Lang,
  warn: ((message: string) => void) | null,
  warned: Set<string> = new Set(),
): Translate {
  return (key, params) => {
    if (warn && !hasSupplierText(key) && !warned.has(key)) {
      warned.add(key);
      warn(`[i18n] the cabinet has no text for "${key}"`);
    }
    return supplierText(lang, key, params);
  };
}
