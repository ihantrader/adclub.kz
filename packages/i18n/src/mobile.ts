import en from "./mobile/en.json";
import kk from "./mobile/kk.json";
import ru from "./mobile/ru.json";
import type { Lang } from "./translate";

/**
 * Texts of the mobile app's screens (TASK-027): the same three languages as
 * the shared dictionary, kept as data next to it so every screen reads its
 * words from a dictionary instead of a string in a component.
 *
 * Russian is the working wording of SCREENS.md; Kazakh is a draft that no
 * native speaker has confirmed yet (`$about` in `mobile/kk.json`).
 */
export const mobileLocales = { en, kk, ru } as const;

/** Keys starting with `$` are notes about the file, not texts of the app. */
type TextKeyOf<T> =
  Extract<keyof T, string> extends infer K ? (K extends `$${string}` ? never : K) : never;

export type MobileTextKey = TextKeyOf<(typeof mobileLocales)["ru"]>;

export function mobileText(lang: Lang, key: MobileTextKey): string {
  return (mobileLocales[lang] as Record<string, string>)[key] ?? mobileLocales.ru[key];
}

/** Every text key of the dictionary, without the `$…` notes. */
export function mobileTextKeys(): MobileTextKey[] {
  return Object.keys(mobileLocales.ru).filter((key) => !key.startsWith("$")) as MobileTextKey[];
}
