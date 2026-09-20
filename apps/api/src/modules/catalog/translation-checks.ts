import {
  catalogNameText,
  translationMaxLengths,
  type TranslationEntityType,
  type TranslationFailure,
  type TranslationField,
  type TranslationTargetLanguage,
} from "@adclub/contracts";
import { normalizeText } from "./catalog-texts";

/**
 * What an automatic translation must satisfy before it is saved
 * (TASK-012, ARCHITECTURE 4.19): the same checks as a text an
 * administrator types (`catalogNameText` — the schema of the admin
 * routes: not empty, within the field's length, no control characters),
 * then the same form (NFC, one space), then that it is in the language
 * asked for. That the name is free among neighbours is checked at saving
 * (`findNameClash`), where the neighbours are.
 */

const CYRILLIC = /\p{Script=Cyrillic}/u;

export type TranslationCheck =
  { ok: true; text: string } | { ok: false; failure: Exclude<TranslationFailure, "name_taken"> };

/** The longest text of a field (characters). */
export function maxLengthOf(entityType: TranslationEntityType, field: TranslationField): number {
  const lengths: Partial<Record<TranslationField, number>> = translationMaxLengths[entityType];
  const max = lengths[field];
  if (max === undefined) {
    throw new Error(`${entityType} has no translatable field "${field}"`);
  }
  return max;
}

/**
 * Checks `raw` as the translation of `source` (Russian) into `lang`.
 * English is written in Latin letters (Cyrillic in it means the text was
 * not translated); Kazakh is written in Cyrillic, so a Russian source with
 * letters can't come back as a Latin-only text.
 */
export function checkTranslation(
  raw: string,
  lang: TranslationTargetLanguage,
  source: string,
  max: number,
): TranslationCheck {
  const parsed = catalogNameText(max).safeParse(raw);
  if (!parsed.success) {
    const codes = new Set(parsed.error.issues.map((issue) => issue.code));
    if (codes.has("invalid_format")) {
      return { ok: false, failure: "control_characters" };
    }
    if (codes.has("too_big")) {
      return { ok: false, failure: "too_long" };
    }
    return { ok: false, failure: "empty" };
  }
  const text = normalizeText(parsed.data);
  if (text.length === 0) {
    return { ok: false, failure: "empty" };
  }
  if (text.length > max) {
    return { ok: false, failure: "too_long" };
  }
  if (lang === "en" && CYRILLIC.test(text)) {
    return { ok: false, failure: "wrong_language" };
  }
  if (lang === "kk" && CYRILLIC.test(source) && !CYRILLIC.test(text)) {
    return { ok: false, failure: "wrong_language" };
  }
  return { ok: true, text };
}
