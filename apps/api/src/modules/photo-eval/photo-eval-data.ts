import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

/**
 * The synthetic sets of the model comparison for the photos of TASK-058
 * (D-058): the dashboard (`ai-eval/dashboard/`, drawn by
 * `scripts/dashboard-samples.mjs`) and a part (`ai-eval/part-photo/`, drawn
 * by `scripts/part-photo-samples.mjs`), each with the values a model should
 * read in `samples.json`. Read from the repository — the comparison is a
 * development tool; nothing in the API or the worker loads the sets.
 */

export type PhotoEvalKind = "dashboard" | "part-photo";

const dashboardSampleSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/u),
  file: z.string().regex(/^samples\/[a-z0-9_-]+\.jpg$/u),
  code: z.number().int().min(1).max(255),
  variant: z.string(),
  style: z.string(),
  readable: z.boolean(),
  acceptKinds: z.array(z.enum(["dashboard", "unreadable"])).optional(),
  /** The number under a thumb or a blur: answering it is a guess, not a false value. */
  hiddenKm: z.number().int().optional(),
  expected: z.object({
    kind: z.enum(["dashboard", "not_dashboard", "unreadable"]),
    totalShown: z.number().int().optional(),
    mileageKm: z.number().int().nullable(),
    unit: z.enum(["km", "mi"]).nullable(),
    tripMeterSeen: z.boolean(),
  }),
});

export type DashboardEvalSample = z.infer<typeof dashboardSampleSchema>;

const partSampleSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/u),
  file: z.string().regex(/^samples\/[a-z0-9_-]+\.jpg$/u),
  code: z.number().int().min(1).max(255),
  variant: z.string(),
  layout: z.string(),
  readable: z.boolean(),
  acceptKinds: z.array(z.enum(["article_found", "no_article", "unreadable"])).optional(),
  hiddenArticle: z.string().optional(),
  expected: z.object({
    kind: z.enum(["article_found", "no_article", "unreadable"]),
    /** Normalized, the part's own first. */
    articles: z.array(z.string()),
    brand: z.string().nullable(),
    /** Numbers on the label that are not articles (a barcode, a batch, a date), normalized. */
    notArticles: z.array(z.string()),
  }),
});

export type PartEvalSample = z.infer<typeof partSampleSchema>;

function fileSchema<T extends z.ZodType>(sample: T) {
  return z.object({
    version: z.number().int().positive(),
    note: z.string().optional(),
    samples: z.array(sample).min(20).max(60),
  });
}

/** Where a set lives, found from this file upwards. */
export function photoEvalDirectory(kind: PhotoEvalKind): string {
  let directory = __dirname;
  for (let depth = 0; depth < 12; depth += 1) {
    try {
      readFileSync(join(directory, "pnpm-workspace.yaml"));
      return join(directory, "ai-eval", kind);
    } catch {
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  throw new Error("The repository root (pnpm-workspace.yaml) was not found above this file");
}

function unique<T extends { id: string; code: number }>(samples: T[]): T[] {
  const ids = new Set<string>();
  const codes = new Set<number>();
  for (const sample of samples) {
    if (ids.has(sample.id)) throw new Error(`The sample id "${sample.id}" is used twice`);
    if (codes.has(sample.code)) {
      throw new Error(`The sample code ${sample.code} is used twice`);
    }
    ids.add(sample.id);
    codes.add(sample.code);
  }
  return samples;
}

export interface PhotoEvalData<Sample> {
  version: number;
  samples: Sample[];
}

export function loadDashboardEvalData(
  directory = photoEvalDirectory("dashboard"),
): PhotoEvalData<DashboardEvalSample> {
  const file = fileSchema(dashboardSampleSchema).parse(
    JSON.parse(readFileSync(join(directory, "samples.json"), "utf8")) as unknown,
  );
  return { version: file.version, samples: unique(file.samples) };
}

export function loadPartEvalData(
  directory = photoEvalDirectory("part-photo"),
): PhotoEvalData<PartEvalSample> {
  const file = fileSchema(partSampleSchema).parse(
    JSON.parse(readFileSync(join(directory, "samples.json"), "utf8")) as unknown,
  );
  return { version: file.version, samples: unique(file.samples) };
}
