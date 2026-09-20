import { z } from "zod";
import type { TranslateGlossaryEntry } from "../ai";
import glossaryFile from "./translation-glossary.json";

/**
 * The terms the automatic translation of the catalog must keep to
 * (TASK-053.B requirement 5, ARCHITECTURE 4.23): a short list of Russian
 * terms with what they are called in Kazakh and English, sent with every
 * batch of texts.
 *
 * It is data — `translation-glossary.json` — so a term is added or
 * corrected by editing that file, not by changing code; it is part of the
 * build like any other file of the API. Whether it travels with the texts
 * at all is the setting `translation_glossary_enabled`.
 *
 * Measured on the sample set of `ai-eval/translate` (TASK-053.B): with
 * these 14 terms the two cheap models tried left no Russian stem inside a
 * Kazakh name and no term rendered two ways, where without them they left
 * four to six of each. The Kazakh and English of the terms themselves
 * come from the catalog drafts of the Product Owner and are not confirmed
 * by a speaker of Kazakh; the full catalog glossary is its own task.
 */

const glossarySchema = z.object({
  version: z.number().int().positive(),
  entries: z
    .array(
      z.object({
        ru: z.string().min(1),
        kk: z.string().min(1).optional(),
        en: z.string().min(1).optional(),
      }),
    )
    .min(1),
});

let cached: TranslateGlossaryEntry[] | undefined;

/** The glossary, parsed once: a broken file must stop the process at its first use, not silently translate without terms. */
export function loadGlossary(): TranslateGlossaryEntry[] {
  cached ??= glossarySchema.parse(glossaryFile).entries;
  return cached;
}
