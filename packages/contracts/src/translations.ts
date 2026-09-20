import { z } from "zod";
import {
  ATTRIBUTE_NAME_MAX_LENGTH,
  ATTRIBUTE_OPTION_NAME_MAX_LENGTH,
  ATTRIBUTE_UNIT_MAX_LENGTH,
  CATEGORY_NAME_MAX_LENGTH,
  catalogNameText,
} from "./catalog";
import {
  CATALOG_ITEM_NAME_MAX_LENGTH,
  CATALOG_PAGE_DEFAULT_SIZE,
  CATALOG_PAGE_MAX_SIZE,
} from "./catalog-items";

/**
 * Translations of the catalog's texts (PRODUCT 6.2; ARCHITECTURE 5.4, 4.19;
 * TASK-012; SCREENS A-CAT-05, tab "Переводы"). The source language is
 * Russian; Kazakh and English are translated by AI in the background
 * (`origin: "ai"`, a working text at once) and the administrator may write
 * them by hand (`origin: "manual"`), which automatic translation never
 * overwrites. Enum values here are only ever added (ARCHITECTURE 7.4).
 */

/** What has translations: the entities whose names and units are kept in `translation`. */
export const translationEntityTypeSchema = z.enum([
  "category",
  "attribute",
  "attribute_option",
  "catalog_item",
]);

export type TranslationEntityType = z.infer<typeof translationEntityTypeSchema>;

export const translationFieldSchema = z.enum(["name", "unit"]);

export type TranslationField = z.infer<typeof translationFieldSchema>;

/** The languages translated into: everything but the source language. */
export const translationTargetLanguageSchema = z.enum(["kk", "en"]);

export type TranslationTargetLanguage = z.infer<typeof translationTargetLanguageSchema>;

/** `source` — the Russian text; `ai` — an automatic translation; `manual` — written by an administrator. */
export const translationOriginSchema = z.enum(["source", "ai", "manual"]);

export type TranslationOrigin = z.infer<typeof translationOriginSchema>;

/**
 * Why an automatic translation was refused for good (it is not saved and
 * not tried again until the source changes or an administrator asks again):
 * `empty`, `too_long` (for the field), `control_characters`,
 * `wrong_language` (English with Cyrillic, Kazakh without it for a Russian
 * source), `name_taken` (a neighbour already has this name in this
 * language).
 */
export const translationFailureSchema = z.enum([
  "empty",
  "too_long",
  "control_characters",
  "wrong_language",
  "name_taken",
]);

export type TranslationFailure = z.infer<typeof translationFailureSchema>;

/** Longest text of a field, in characters — the same limits as writing it by hand. */
export const translationMaxLengths = {
  category: { name: CATEGORY_NAME_MAX_LENGTH },
  attribute: { name: ATTRIBUTE_NAME_MAX_LENGTH, unit: ATTRIBUTE_UNIT_MAX_LENGTH },
  attribute_option: { name: ATTRIBUTE_OPTION_NAME_MAX_LENGTH },
  catalog_item: { name: CATALOG_ITEM_NAME_MAX_LENGTH },
} as const satisfies Record<TranslationEntityType, Partial<Record<TranslationField, number>>>;

export const translationEntityPathSchema = z.object({
  entityType: translationEntityTypeSchema,
  entityId: z.uuid(),
});

export type TranslationEntityPath = z.infer<typeof translationEntityPathSchema>;

export const translationTargetPathSchema = translationEntityPathSchema.extend({
  field: translationFieldSchema,
  lang: translationTargetLanguageSchema,
});

export type TranslationTargetPath = z.infer<typeof translationTargetPathSchema>;

/** One stored text in one language. */
export const translationTextSchema = z.object({
  text: z.string(),
  origin: translationOriginSchema,
  /** Written by an administrator: automatic translation never overwrites it. */
  isManuallyEdited: z.boolean(),
  /**
   * The Russian text changed after this one was made (`source_hash` differs
   * from the hash of the current Russian text). A manual translation stays
   * as it is and is flagged for the administrator; an automatic one is
   * replaced by a new translation (it is queued).
   */
  isSourceChanged: z.boolean(),
  /** The model of an automatic translation; `null` for the others. */
  aiModel: z.string().nullable(),
  /** When the text was last written. */
  updatedAt: z.iso.datetime(),
});

export type TranslationText = z.infer<typeof translationTextSchema>;

/**
 * An automatic translation still to be made (`queued`) or refused for good
 * (`failed`, with the reason). `attempts` — how many times a run failed on
 * it for a temporary reason.
 */
export const translationTaskSchema = z.object({
  state: z.enum(["queued", "failed"]),
  failure: translationFailureSchema.nullable(),
  attempts: z.number().int(),
  updatedAt: z.iso.datetime(),
});

export type TranslationTask = z.infer<typeof translationTaskSchema>;

/** A language of a field: its text (`null` — none, clients get Russian) and its pending task. */
export const translationLanguageSchema = z.object({
  translation: translationTextSchema.nullable(),
  task: translationTaskSchema.nullable(),
});

export type TranslationLanguage = z.infer<typeof translationLanguageSchema>;

export const translationFieldViewSchema = z.object({
  field: translationFieldSchema,
  texts: z.object({
    kk: translationLanguageSchema,
    ru: translationLanguageSchema,
    en: translationLanguageSchema,
  }),
});

export type TranslationFieldView = z.infer<typeof translationFieldViewSchema>;

/** The tab "Переводы" of one entity: every field that has a Russian text. */
export const entityTranslationsResponseSchema = z.object({
  entityType: translationEntityTypeSchema,
  entityId: z.uuid(),
  fields: z.array(translationFieldViewSchema),
});

export type EntityTranslationsResponse = z.infer<typeof entityTranslationsResponseSchema>;

/** A manual translation: brought to one form (NFC, spaces) by the server and checked as any name. */
export const editTranslationBodySchema = z.object({
  text: catalogNameText(CATALOG_ITEM_NAME_MAX_LENGTH),
});

export type EditTranslationBody = z.infer<typeof editTranslationBodySchema>;

/**
 * What the list shows:
 * - `missing` — no translation and nobody has asked for one (cleared by an
 *   administrator, or from before automatic translation);
 * - `queued` — an automatic translation is waiting for a run;
 * - `failed` — the last translation was refused for good (see `failure`);
 * - `outdated` — a text exists, but the Russian one changed since (a manual
 *   translation the administrator should look at).
 */
export const translationQueueStateSchema = z.enum(["missing", "queued", "failed", "outdated"]);

export type TranslationQueueState = z.infer<typeof translationQueueStateSchema>;

export const translationQueueQuerySchema = z.object({
  entityType: translationEntityTypeSchema.optional(),
  lang: translationTargetLanguageSchema.optional(),
  state: translationQueueStateSchema.optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(CATALOG_PAGE_MAX_SIZE)
    .default(CATALOG_PAGE_DEFAULT_SIZE),
  cursor: z.string().min(1).max(300).optional(),
});

export type TranslationQueueQuery = z.infer<typeof translationQueueQuerySchema>;

export const translationQueueItemSchema = z.object({
  entityType: translationEntityTypeSchema,
  entityId: z.uuid(),
  field: translationFieldSchema,
  lang: translationTargetLanguageSchema,
  state: translationQueueStateSchema,
  /** The Russian text the translation is made from. */
  sourceText: z.string(),
  /** The text in this language now, if any. */
  currentText: z.string().nullable(),
  currentOrigin: translationOriginSchema.nullable(),
  isSourceChanged: z.boolean(),
  failure: translationFailureSchema.nullable(),
});

export type TranslationQueueItem = z.infer<typeof translationQueueItemSchema>;

export const translationQueuePageSchema = z.object({
  items: z.array(translationQueueItemSchema),
  /** How many items match the filters (`state` included), over all pages. */
  total: z.number().int(),
  /** How many match `entityType` and `lang`, by state — the volume of work. */
  counts: z.object({
    missing: z.number().int(),
    queued: z.number().int(),
    failed: z.number().int(),
    outdated: z.number().int(),
  }),
  nextCursor: z.string().nullable(),
});

export type TranslationQueuePage = z.infer<typeof translationQueuePageSchema>;
