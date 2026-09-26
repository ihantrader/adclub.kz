import type { Lang } from "./translate";

/**
 * Which form of a counted noun a number takes (TASK-028). Written out
 * rather than taken from `Intl.PluralRules`, because the engine of the
 * mobile app (Hermes) is built with a locale set we do not control, and a
 * catalog that says «3 предложений» is a visible defect.
 *
 * Russian has three forms; English has two and Kazakh has none (a noun
 * after a numeral stays singular), so both of them only ever ask for
 * `one` and `many` — a dictionary still carries all three keys per word,
 * so the key sets of the three languages stay identical.
 */
export type PluralForm = "one" | "few" | "many";

export function pluralForm(lang: Lang, count: number): PluralForm {
  const n = Math.abs(Math.trunc(count));
  if (lang === "ru") {
    const tens = n % 100;
    if (tens >= 11 && tens <= 14) return "many";
    const ones = n % 10;
    if (ones === 1) return "one";
    if (ones >= 2 && ones <= 4) return "few";
    return "many";
  }
  if (lang === "en") return n === 1 ? "one" : "many";
  // Kazakh: «1 ұсыныс», «3 ұсыныс» — one form for every number.
  return "many";
}

/**
 * Fills `{name}` placeholders of a dictionary text. A placeholder with no
 * value is left as it is: a visible `{город}` in a draft screen is easier
 * to notice than a silent gap.
 */
export function formatText(template: string, params?: Readonly<Record<string, string | number>>) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}
