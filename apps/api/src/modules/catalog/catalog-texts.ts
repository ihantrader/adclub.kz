import { createHash } from "node:crypto";
import type { CatalogLanguage, CatalogText, CatalogTexts, LocalizedText } from "@adclub/contracts";
import { and, eq, inArray } from "drizzle-orm";
import type { DbExecutor } from "../../database";
import {
  translation,
  type TranslationEntityType,
  type TranslationField,
  type TranslationRow,
} from "./schema";

/**
 * Names and units of the catalog in `translation` (ARCHITECTURE 5.4, 4.15):
 * the administrator writes Russian (`origin = source`) and, if they wish,
 * Kazakh and English (`origin = manual`); every text written by the
 * administrator is manually edited, so automatic translation (TASK-012)
 * never overwrites it. A translation keeps the hash of the Russian text it
 * was written against: when Russian changes later, TASK-012 can tell the
 * translation may be outdated.
 */

export const SOURCE_LANGUAGE = "ru" satisfies CatalogLanguage;

const LANGUAGES: readonly CatalogLanguage[] = ["kk", "ru", "en"];

/** What an administrator sends: Russian text; Kazakh/English text or `null` to clear; absent — unchanged. */
export interface TextChanges {
  ru?: string;
  kk?: string | null;
  en?: string | null;
}

/** The texts of one field of one entity, by language. */
export type StoredTexts = Partial<Record<CatalogLanguage, TranslationRow>>;

/** Texts of many entities: entity id → field → language → row. */
export type TextIndex = Map<string, Partial<Record<TranslationField, StoredTexts>>>;

/** One form for storing and comparing: Unicode NFC, runs of whitespace as one space, trimmed. */
export function normalizeText(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

/** Names equal for a person: case does not matter (`Колодки` = `колодки`). */
export function nameKey(value: string): string {
  return normalizeText(value).toLowerCase();
}

function sourceHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export async function loadTexts(
  executor: DbExecutor,
  entityType: TranslationEntityType,
  entityIds: readonly string[],
): Promise<TextIndex> {
  const index: TextIndex = new Map();
  if (entityIds.length === 0) {
    return index;
  }
  const rows = await executor
    .select()
    .from(translation)
    .where(
      and(eq(translation.entityType, entityType), inArray(translation.entityId, [...entityIds])),
    );
  for (const row of rows) {
    const fields = index.get(row.entityId) ?? {};
    const texts = (fields[row.field] ??= {});
    texts[row.lang] = row;
    index.set(row.entityId, fields);
  }
  return index;
}

export function textsOf(index: TextIndex, entityId: string, field: TranslationField): StoredTexts {
  return index.get(entityId)?.[field] ?? {};
}

function toCatalogText(row: TranslationRow | undefined): CatalogText | null {
  return row
    ? { text: row.text, origin: row.origin, isManuallyEdited: row.isManuallyEdited }
    : null;
}

/** The admin panel's view: every language with its origin. */
export function describeTexts(texts: StoredTexts): CatalogTexts {
  return { kk: toCatalogText(texts.kk), ru: toCatalogText(texts.ru), en: toCatalogText(texts.en) };
}

/** Plain texts by language (`null` — none), for the action journal and comparisons. */
export function plainTexts(texts: StoredTexts): Record<CatalogLanguage, string | null> {
  return { kk: texts.kk?.text ?? null, ru: texts.ru?.text ?? null, en: texts.en?.text ?? null };
}

/**
 * The text in the language asked for; without it, the Russian one marked
 * as a fallback (edge case 17.8). `null` only if there is no Russian text
 * either — which the checks of this module never let happen.
 */
export function localize(texts: StoredTexts, lang: CatalogLanguage): LocalizedText | null {
  const own = texts[lang];
  if (own) {
    return { text: own.text, isFallback: false };
  }
  const source = texts[SOURCE_LANGUAGE];
  return source ? { text: source.text, isFallback: lang !== SOURCE_LANGUAGE } : null;
}

/** The texts after `changes`, normalized (`null` — none in that language). */
export function mergeTexts(
  current: Record<CatalogLanguage, string | null>,
  changes: TextChanges | undefined,
): Record<CatalogLanguage, string | null> {
  const merged = { ...current };
  if (!changes) {
    return merged;
  }
  for (const lang of LANGUAGES) {
    const value = changes[lang];
    if (value !== undefined) {
      merged[lang] = value === null ? null : normalizeText(value);
    }
  }
  return merged;
}

/**
 * Writes one field of one entity so it holds exactly `wanted` (a
 * language with `null` is removed). Rows whose text doesn't change are
 * left as they are — their origin and hash stay true.
 */
export async function writeTexts(
  executor: DbExecutor,
  entityType: TranslationEntityType,
  entityId: string,
  field: TranslationField,
  current: StoredTexts,
  wanted: Record<CatalogLanguage, string | null>,
): Promise<void> {
  const source = wanted[SOURCE_LANGUAGE];
  for (const lang of LANGUAGES) {
    const text = wanted[lang];
    const existing = current[lang];
    if (text === null) {
      if (existing) {
        await executor.delete(translation).where(eq(translation.id, existing.id));
      }
      continue;
    }
    if (existing && existing.text === text) {
      continue;
    }
    const isSource = lang === SOURCE_LANGUAGE;
    if (!isSource && source === null) {
      throw new Error(`A ${lang} ${field} of ${entityType} ${entityId} without a Russian one`);
    }
    const values = {
      text,
      origin: isSource ? ("source" as const) : ("manual" as const),
      isManuallyEdited: true,
      sourceHash: isSource ? null : sourceHash(source as string),
      updatedAt: new Date(),
    };
    if (existing) {
      await executor.update(translation).set(values).where(eq(translation.id, existing.id));
    } else {
      await executor.insert(translation).values({ entityType, entityId, field, lang, ...values });
    }
  }
}

/** Every language that has a text, in order. */
export function languagesOf(
  texts: Record<CatalogLanguage, string | null>,
): { lang: CatalogLanguage; text: string }[] {
  return LANGUAGES.flatMap((lang) => {
    const text = texts[lang];
    return text === null ? [] : [{ lang, text }];
  });
}
