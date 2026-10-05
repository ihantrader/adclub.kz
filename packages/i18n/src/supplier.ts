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

export function supplierText(
  lang: Lang,
  key: SupplierTextKey,
  params?: Readonly<Record<string, string | number>>,
): string {
  const text = (supplierLocales[lang] as Record<string, string>)[key] ?? supplierLocales.ru[key];
  return formatText(text, params);
}

/** Every text key of the dictionary, without the `$…` notes. */
export function supplierTextKeys(): SupplierTextKey[] {
  return Object.keys(supplierLocales.ru).filter((key) => !key.startsWith("$")) as SupplierTextKey[];
}
