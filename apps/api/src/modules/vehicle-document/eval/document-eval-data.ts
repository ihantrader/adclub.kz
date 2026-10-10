import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { carColorIdSchema } from "@adclub/contracts";
import { z } from "zod";

/**
 * The synthetic set of the model comparison for reading a registration
 * certificate (TASK-057 requirement 2, D-058): pictures drawn by
 * `scripts/vehicle-document-samples.mjs` with made-up data, and the values a
 * model should read from each, in `ai-eval/vehicle-document/samples.json`.
 * Read from the repository — the comparison is a development tool; nothing
 * in the API or the worker loads the set.
 */

const expectedSchema = z.object({
  documentKind: z.enum(["kz_registration", "other_document", "not_document"]),
  make: z.string().nullable(),
  model: z.string().nullable(),
  year: z.number().int().nullable(),
  vin: z.string().nullable(),
  plate: z.string().nullable(),
  engineVolumeCc: z.number().int().nullable(),
  color: z.string().nullable(),
  colorId: carColorIdSchema.nullable(),
});

const sampleSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/u),
  file: z.string().regex(/^samples\/[a-z0-9_-]+\.jpg$/u),
  code: z.number().int().min(1).max(255),
  form: z.enum(["new", "old", "ru_sts", "kz_license", "not_document"]),
  variant: z.enum(["clean", "glare", "tilt", "blur", "occluded", "lowres"]),
  readable: z.boolean(),
  acceptKinds: z.array(z.enum(["kz_registration", "unreadable"])).optional(),
  expected: expectedSchema,
  mustNotAppear: z.array(z.string()),
});

const samplesFileSchema = z.object({
  version: z.number().int().positive(),
  note: z.string().optional(),
  samples: z.array(sampleSchema).min(20).max(60),
});

export type DocumentEvalSample = z.infer<typeof sampleSchema>;

export interface DocumentEvalData {
  version: number;
  samples: DocumentEvalSample[];
}

/** Where the set lives, found from this file upwards. */
export function vehicleDocumentEvalDirectory(): string {
  let directory = __dirname;
  for (let depth = 0; depth < 12; depth += 1) {
    try {
      readFileSync(join(directory, "pnpm-workspace.yaml"));
      return join(directory, "ai-eval", "vehicle-document");
    } catch {
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  throw new Error("The repository root (pnpm-workspace.yaml) was not found above this file");
}

export function loadDocumentEvalData(directory = vehicleDocumentEvalDirectory()): DocumentEvalData {
  const file = samplesFileSchema.parse(
    JSON.parse(readFileSync(join(directory, "samples.json"), "utf8")) as unknown,
  );
  const ids = new Set<string>();
  for (const sample of file.samples) {
    if (ids.has(sample.id)) throw new Error(`The sample id "${sample.id}" is used twice`);
    ids.add(sample.id);
  }
  return { version: file.version, samples: file.samples };
}
