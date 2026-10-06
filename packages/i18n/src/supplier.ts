import en from "./supplier/en.json";
import kk from "./supplier/kk.json";
import ru from "./supplier/ru.json";
import { formatText } from "./plural";
import type { Lang } from "./translate";

/**
 * Texts of the supplier cabinet (TASK-031): the same three languages as the
 * mobile app's dictionary and kept the same way — as data, so every screen
 * of the cabinet reads its words from here instead of a string in a
 * component.
 *
 * Russian is the working wording of SCREENS.md; Kazakh is a draft that no
 * native speaker has confirmed yet (`$about` in `supplier/kk.json`).
 */
export const supplierLocales = { en, kk, ru } as const;

/** Keys starting with `$` are notes about the file, not texts of the cabinet. */
type TextKeyOf<T> =
  Extract<keyof T, string> extends infer K ? (K extends `$${string}` ? never : K) : never;

export type SupplierTextKey = TextKeyOf<(typeof supplierLocales)["ru"]>;

/**
 * The text of `key` in `lang`, Russian when the language has none. A key
 * the dictionary does not know at all (a code built from a server value,
 * a text not added yet) never breaks a screen: the key itself is shown —
 * `hasSupplierText` lets the cabinet warn about it in development.
 */
export function supplierText(
  lang: Lang,
  key: SupplierTextKey,
  params?: Readonly<Record<string, string | number>>,
): string {
  const text =
    (supplierLocales[lang] as Record<string, string | undefined>)[key] ??
    (supplierLocales.ru as Record<string, string | undefined>)[key] ??
    key;
  return formatText(text, params);
}

/** Whether the dictionary has a text for `key` (in Russian, the working wording). */
export function hasSupplierText(key: string): boolean {
  return !key.startsWith("$") && Object.prototype.hasOwnProperty.call(supplierLocales.ru, key);
}

/** Every text key of the dictionary, without the `$…` notes. */
export function supplierTextKeys(): SupplierTextKey[] {
  return Object.keys(supplierLocales.ru).filter((key) => !key.startsWith("$")) as SupplierTextKey[];
}
