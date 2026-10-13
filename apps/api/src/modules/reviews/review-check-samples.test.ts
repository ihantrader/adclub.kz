import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { reviewRuleFindings } from "@adclub/domain";
import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * The set of examples for the review check (`ai-eval/review-check/samples.json`,
 * TASK-049): the deterministic rules must find exactly the rule kinds the set
 * expects (contacts, the supplier's name, an employee's name) — and nothing in
 * criticism; the AI kinds are data for a future measurement of models (D-058),
 * nothing calls a model here.
 */

const RULE_KINDS = new Set(["contacts", "supplier_name", "employee_name"]);

const samplesFileSchema = z.object({
  version: z.number().int().positive(),
  about: z.string(),
  supplier: z.object({ name: z.string(), employees: z.array(z.string()) }),
  samples: z
    .array(
      z.object({
        id: z.string(),
        lang: z.enum(["ru", "kk", "en", "mixed", "translit"]),
        score: z.number().int().min(1).max(5),
        text: z.string().min(1),
        expected: z.array(
          z.enum([
            "contacts",
            "supplier_name",
            "employee_name",
            "profanity",
            "threat",
            "personal_data",
            "advertising",
          ]),
        ),
        note: z.string().optional(),
      }),
    )
    .min(30),
});

function samplesFile(): string {
  let directory = __dirname;
  for (let depth = 0; depth < 12; depth += 1) {
    try {
      readFileSync(join(directory, "pnpm-workspace.yaml"));
      return join(directory, "ai-eval", "review-check", "samples.json");
    } catch {
      directory = dirname(directory);
    }
  }
  throw new Error("The repository root (pnpm-workspace.yaml) was not found above this file");
}

const set = samplesFileSchema.parse(JSON.parse(readFileSync(samplesFile(), "utf8")) as unknown);

describe("the examples of the review check (ai-eval/review-check)", () => {
  it("covers kk, ru, en, mixed speech and transliteration, criticism and every kind", () => {
    expect(new Set(set.samples.map((sample) => sample.id)).size).toBe(set.samples.length);
    expect(new Set(set.samples.map((sample) => sample.lang))).toEqual(
      new Set(["ru", "kk", "en", "mixed", "translit"]),
    );
    const kinds = new Set(set.samples.flatMap((sample) => sample.expected));
    expect(kinds.size).toBe(7);
    expect(set.samples.filter((sample) => sample.expected.length === 0).length).toBeGreaterThan(10);
  });

  it.each(set.samples.map((sample) => [sample.id, sample] as const))(
    "the rules agree with %s",
    (_id, sample) => {
      const found = reviewRuleFindings(sample.text, {
        supplierNames: [set.supplier.name],
        employeeNames: set.supplier.employees,
      }).map((finding) => finding.kind);
      expect(found).toEqual(sample.expected.filter((kind) => RULE_KINDS.has(kind)));
    },
  );
});
