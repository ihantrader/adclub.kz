import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  translationEntityTypeSchema,
  translationFieldSchema,
  type TranslationEntityType,
  type TranslationField,
} from "@adclub/contracts";
import { z } from "zod";
import { loadGlossary } from "../translation-glossary";

/**
 * The data of the model comparison (TASK-053.B, D-058): the sample set
 * and the term dictionary of the checks live in `ai-eval/translate/` as
 * JSON — data, not code — so the set can be re-run against new models and
 * new prices later, and a run saved in `ai-eval/translate/results/` is
 * comparable with the next one. Read from the repository, so the
 * comparison is a development tool; nothing in the API or the worker
 * loads them.
 *
 * The glossary is the exception: the running translation uses it too
 * (`translation-glossary.ts`), so it lives in the source tree and is part
 * of the build like any other file of the API.
 */

const sampleSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/u),
  text: z.string().min(1),
  entityType: translationEntityTypeSchema,
  field: translationFieldSchema,
  scope: z.string().min(1),
  note: z.string().optional(),
});

const samplesFileSchema = z.object({
  version: z.number().int().positive(),
  samples: z.array(sampleSchema).min(40).max(60),
});

const termSchema = z.object({
  ru: z.string().min(1),
  samples: z.array(z.string().min(1)).min(1),
  kkForms: z.array(z.string().min(1)).min(1),
  kkRussisms: z.array(z.string().min(1)).default([]),
  enForms: z.array(z.string().min(1)).default([]),
});

const termsFileSchema = z.object({
  version: z.number().int().positive(),
  terms: z.array(termSchema).min(1),
});

export interface EvalSample {
  id: string;
  text: string;
  entityType: TranslationEntityType;
  field: TranslationField;
  /** Neighbours: two samples of one scope must not end up with the same name. */
  scope: string;
  note?: string;
}

export interface EvalTerm {
  ru: string;
  samples: string[];
  kkForms: string[];
  kkRussisms: string[];
  enForms: string[];
}

export interface EvalData {
  version: number;
  samples: EvalSample[];
  terms: EvalTerm[];
}

/** Where the data of the comparison lives, found from this file upwards. */
export function evalDataDirectory(): string {
  let directory = __dirname;
  for (let depth = 0; depth < 10; depth += 1) {
    try {
      readFileSync(join(directory, "pnpm-workspace.yaml"));
      return join(directory, "ai-eval", "translate");
    } catch {
      const parent = dirname(directory);
      if (parent === directory) {
        break;
      }
      directory = parent;
    }
  }
  throw new Error("The repository root (pnpm-workspace.yaml) was not found above this file");
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

/**
 * The sample set and the term dictionary, checked: the sizes the task
 * fixed (40–60 samples), ids unique, every sample of a term known, and
 * both files of one version — a run of one version is only comparable
 * with a run of the same one.
 */
export function loadEvalData(directory = evalDataDirectory()): EvalData {
  const samplesFile = samplesFileSchema.parse(readJson(join(directory, "samples.json")));
  const termsFile = termsFileSchema.parse(readJson(join(directory, "terms.json")));
  const ids = new Set<string>();
  for (const sample of samplesFile.samples) {
    if (ids.has(sample.id)) {
      throw new Error(`The sample id "${sample.id}" is used twice`);
    }
    ids.add(sample.id);
  }
  const texts = new Set<string>();
  for (const sample of samplesFile.samples) {
    const key = sample.text.toLowerCase();
    if (texts.has(key)) {
      throw new Error(`The sample text "${sample.text}" is in the set twice`);
    }
    texts.add(key);
  }
  for (const term of termsFile.terms) {
    for (const id of term.samples) {
      if (!ids.has(id)) {
        throw new Error(`The term "${term.ru}" names a sample that is not in the set: ${id}`);
      }
    }
  }
  if (samplesFile.version !== termsFile.version) {
    throw new Error(
      `samples.json is version ${samplesFile.version} and terms.json version ${termsFile.version}; they are one set and must match`,
    );
  }
  return { version: samplesFile.version, samples: samplesFile.samples, terms: termsFile.terms };
}

export { loadGlossary };
