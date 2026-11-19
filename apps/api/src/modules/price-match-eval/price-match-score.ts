import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PRICE_AUDIT_BUCKETS, priceAuditBucket, type PriceAuditBucket } from "@adclub/domain";
import { z } from "zod";

/**
 * The model comparison of `price_match` (TASK-065, D-058): the synthetic set
 * `ai-eval/price-match/samples.json` — rows of price lists with the
 * candidates the search would give and the item each really is (or none),
 * against the dev catalog — and the scoring of a model's answers. Read from
 * the repository; nothing in the API or the worker loads the set.
 */

const keySchema = z.string().regex(/^[a-z0-9-]+$/u);

const itemSchema = z.object({
  key: keySchema,
  name: z.string().min(1),
  brand: z.string().nullable(),
  article: z.string().nullable(),
  category: z.string().min(1),
});

export type PriceMatchEvalItem = z.infer<typeof itemSchema>;

const sampleSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/u),
  lang: z.enum(["kk", "ru", "en"]),
  article: z.string().nullable(),
  brand: z.string().nullable(),
  name: z.string().min(1),
  candidates: z.array(keySchema).min(1).max(3),
  /** The item the row is; `null` — none of the candidates. */
  expected: keySchema.nullable(),
});

export type PriceMatchEvalSample = z.infer<typeof sampleSchema>;

export interface PriceMatchEvalData {
  version: number;
  items: PriceMatchEvalItem[];
  samples: PriceMatchEvalSample[];
}

/** Where the set lives, found from this file upwards. */
export function priceMatchEvalDirectory(): string {
  let directory = __dirname;
  for (let depth = 0; depth < 12; depth += 1) {
    try {
      readFileSync(join(directory, "pnpm-workspace.yaml"));
      return join(directory, "ai-eval", "price-match");
    } catch {
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  throw new Error("The repository root (pnpm-workspace.yaml) was not found above this file");
}

/** Reads and checks the set: unique ids and keys, candidates and answers among the items. */
export function loadPriceMatchEvalData(directory = priceMatchEvalDirectory()): PriceMatchEvalData {
  const file = z
    .object({
      version: z.number().int().positive(),
      note: z.string().optional(),
      items: z.array(itemSchema).min(2),
      samples: z.array(sampleSchema).min(40).max(60),
    })
    .parse(JSON.parse(readFileSync(join(directory, "samples.json"), "utf8")) as unknown);
  const keys = new Set<string>();
  for (const item of file.items) {
    if (keys.has(item.key)) throw new Error(`Item ${item.key} twice in the set`);
    keys.add(item.key);
  }
  const ids = new Set<string>();
  for (const sample of file.samples) {
    if (ids.has(sample.id)) throw new Error(`Sample ${sample.id} twice in the set`);
    ids.add(sample.id);
    for (const key of sample.candidates) {
      if (!keys.has(key)) throw new Error(`Sample ${sample.id}: no item ${key}`);
    }
    if (new Set(sample.candidates).size !== sample.candidates.length) {
      throw new Error(`Sample ${sample.id}: a candidate twice`);
    }
    if (sample.expected !== null && !sample.candidates.includes(sample.expected)) {
      throw new Error(`Sample ${sample.id}: the expected item is not a candidate`);
    }
  }
  return { version: file.version, items: file.items, samples: file.samples };
}

/** What a model answered of one row; `undefined` in the map — it left the row out. */
export interface PriceMatchEvalAnswer {
  itemId: string | null;
  confidence: number;
  explanation: string;
}

export interface PriceMatchBucketScore {
  bucket: PriceAuditBucket;
  /** Rows where the model named an item with a confidence in the bucket. */
  proposed: number;
  correct: number;
  accuracy: number | null;
}

export interface PriceMatchScore {
  samples: number;
  answered: number;
  /** The answer is the expected one (an item, or none). */
  correct: number;
  accuracy: number;
  /** The model named an item and it is not the row's (another candidate, or the row has none). */
  falseMatches: number;
  falseMatchShare: number;
  /** The model said «none» of a row that has its item. */
  missed: number;
  /** Rows without an item answered «none». */
  noneCorrect: number;
  noneTotal: number;
  /** Calibration: of the items named, how many were right, by the buckets of the audit. */
  buckets: PriceMatchBucketScore[];
  /** Named items at or above the threshold: how many and how many right — what «предложено ИИ» shows. */
  atThreshold: { threshold: number; proposed: number; correct: number; precision: number | null };
  /** The bar of D-058 for this operation: accuracy ≥ 0.9 and false matches ≤ 0.05. */
  passes: boolean;
  misses: { sampleId: string; expected: string | null; answered: string | null | undefined }[];
}

export const PRICE_MATCH_THRESHOLD = { accuracy: 0.9, falseMatchShare: 0.05 } as const;

const ratio = (part: number, whole: number): number | null =>
  whole === 0 ? null : Math.round((part / whole) * 1000) / 1000;

/** Scores the answers by item key against the set. */
export function scorePriceMatch(
  samples: readonly PriceMatchEvalSample[],
  answers: ReadonlyMap<string, PriceMatchEvalAnswer>,
  threshold = 0.85,
): PriceMatchScore {
  let answered = 0;
  let correct = 0;
  let falseMatches = 0;
  let missed = 0;
  let noneCorrect = 0;
  let noneTotal = 0;
  let thresholdProposed = 0;
  let thresholdCorrect = 0;
  const buckets = new Map(
    PRICE_AUDIT_BUCKETS.map((bucket) => [bucket.id, { proposed: 0, correct: 0 }]),
  );
  const misses: PriceMatchScore["misses"] = [];
  for (const sample of samples) {
    if (sample.expected === null) noneTotal += 1;
    const answer = answers.get(sample.id);
    if (!answer) {
      misses.push({ sampleId: sample.id, expected: sample.expected, answered: undefined });
      continue;
    }
    answered += 1;
    const right = answer.itemId === sample.expected;
    if (right) correct += 1;
    else misses.push({ sampleId: sample.id, expected: sample.expected, answered: answer.itemId });
    if (answer.itemId === null) {
      if (sample.expected === null) noneCorrect += 1;
      else missed += 1;
      continue;
    }
    if (!right) falseMatches += 1;
    const bucket = buckets.get(priceAuditBucket(answer.confidence))!;
    bucket.proposed += 1;
    if (right) bucket.correct += 1;
    if (answer.confidence >= threshold) {
      thresholdProposed += 1;
      if (right) thresholdCorrect += 1;
    }
  }
  const total = samples.length;
  const accuracy = ratio(correct, total) ?? 0;
  const falseMatchShare = ratio(falseMatches, total) ?? 0;
  return {
    samples: total,
    answered,
    correct,
    accuracy,
    falseMatches,
    falseMatchShare,
    missed,
    noneCorrect,
    noneTotal,
    buckets: PRICE_AUDIT_BUCKETS.map((bucket) => {
      const entry = buckets.get(bucket.id)!;
      return {
        bucket: bucket.id,
        proposed: entry.proposed,
        correct: entry.correct,
        accuracy: ratio(entry.correct, entry.proposed),
      };
    }),
    atThreshold: {
      threshold,
      proposed: thresholdProposed,
      correct: thresholdCorrect,
      precision: ratio(thresholdCorrect, thresholdProposed),
    },
    passes:
      accuracy >= PRICE_MATCH_THRESHOLD.accuracy &&
      falseMatchShare <= PRICE_MATCH_THRESHOLD.falseMatchShare,
    misses,
  };
}
