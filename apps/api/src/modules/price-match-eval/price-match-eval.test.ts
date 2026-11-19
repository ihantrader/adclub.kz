import { describe, expect, it } from "vitest";
import {
  priceMatchOutputSchema,
  TestAiGateway,
  type AiCallMeta,
  type AiService,
  type PriceMatchInput,
} from "../ai";
import type { DatabaseService } from "../../database";
import { PriceMatchEval, priceMatchEvalInput, renderPriceMatchEvalRun } from "./price-match-eval";
import {
  loadPriceMatchEvalData,
  scorePriceMatch,
  type PriceMatchEvalAnswer,
} from "./price-match-score";

/**
 * `ai:eval:price-match` on the test AI (TASK-065 AC-6): the set in the
 * repository is consistent; the runner sends the rows as the worker does
 * and scores exactly what the model answered — checked against the test
 * gateway's own answers scored independently.
 */

const data = loadPriceMatchEvalData();

/** `AiService.matchPrices` over the test gateway, with the call bookkeeping left out. */
function testAi(gateway: TestAiGateway, calls: { model: string; rows: number }[]) {
  return {
    provider: "test",
    async matchPrices(input: PriceMatchInput, meta: AiCallMeta) {
      calls.push({ model: meta.model!, rows: input.rows.length });
      const result = await gateway.matchPrices(input, meta.model!, new AbortController().signal);
      return {
        output: priceMatchOutputSchema.parse(result.output),
        jobId: `job-${String(calls.length)}`,
        model: result.model,
        provider: "test",
        usedFallback: false,
      };
    },
  } as unknown as AiService;
}

class EvalWithoutDatabase extends PriceMatchEval {
  protected override async jobUsage() {
    return { costUsd: 0.0001, costIsEstimate: false, tokensIn: 100, tokensOut: 20 };
  }
}

describe("the price_match set", () => {
  it("is 40–60 rows over the dev catalog, with rows that have no item", () => {
    expect(data.samples.length).toBeGreaterThanOrEqual(40);
    expect(data.samples.length).toBeLessThanOrEqual(60);
    expect(data.samples.filter((sample) => sample.expected === null).length).toBeGreaterThan(10);
    for (const lang of ["ru", "kk", "en"] as const) {
      expect(
        data.samples.some((sample) => sample.lang === lang),
        lang,
      ).toBe(true);
    }
    // The articles of the dev catalog's pads are those of `dev:catalog:seed`.
    expect(
      data.items
        .map((item) => item.article)
        .filter(Boolean)
        .sort(),
    ).toEqual(["04465-0K090", "4050068800", "GDB3534"].sort());
  });

  it("scores the expected answers as all right, and a wrong item as a false match", () => {
    const perfect = new Map<string, PriceMatchEvalAnswer>(
      data.samples.map((sample) => [
        sample.id,
        { itemId: sample.expected, confidence: 0.96, explanation: "" },
      ]),
    );
    const score = scorePriceMatch(data.samples, perfect);
    expect(score).toMatchObject({
      correct: data.samples.length,
      accuracy: 1,
      falseMatches: 0,
      passes: true,
    });
    const withItem = data.samples.find((sample) => sample.expected !== null)!;
    const without = data.samples.find((sample) => sample.expected === null)!;
    const worse = new Map(perfect);
    worse.set(without.id, { itemId: without.candidates[0]!, confidence: 0.7, explanation: "" });
    worse.set(withItem.id, { itemId: null, confidence: 0.9, explanation: "" });
    const scored = scorePriceMatch(data.samples, worse);
    expect(scored).toMatchObject({
      correct: data.samples.length - 2,
      falseMatches: 1,
      missed: 1,
    });
    expect(scored.buckets.find((bucket) => bucket.bucket === "0_7_0_85")).toEqual({
      bucket: "0_7_0_85",
      proposed: 1,
      correct: 0,
      accuracy: 0,
    });
  });
});

describe("PriceMatchEval on the test AI", () => {
  it("sends every row in batches to the named model and scores what it answered", async () => {
    const gateway = new TestAiGateway();
    const calls: { model: string; rows: number }[] = [];
    const runner = new EvalWithoutDatabase(testAi(gateway, calls), {} as DatabaseService);
    const run = await runner.run({ models: ["test/model-a"], label: "unit" });
    expect(calls.map((call) => call.model)).toEqual(calls.map(() => "test/model-a"));
    expect(calls.reduce((sum, call) => sum + call.rows, 0)).toBe(data.samples.length);

    // Independently: the test gateway's answers to the same rows, scored.
    const direct = await gateway.matchPrices(
      priceMatchEvalInput(data, data.samples),
      "test/model-a",
      new AbortController().signal,
    );
    const answers = new Map<string, PriceMatchEvalAnswer>(
      priceMatchOutputSchema
        .parse(direct.output)
        .matches.map((match) => [
          match.id,
          { itemId: match.itemId, confidence: match.confidence, explanation: match.explanation },
        ]),
    );
    const expected = scorePriceMatch(data.samples, answers);
    const [result] = run.results;
    expect(result!.score).toEqual(expected);
    expect(result!.calls).toBe(calls.length);
    expect(result!.costUsd).toBeCloseTo(0.0001 * calls.length, 6);
    expect(Object.keys(result!.answers)).toHaveLength(data.samples.length);
    const table = renderPriceMatchEvalRun(run);
    expect(table).toContain("test/model-a");
    expect(table).toContain("Калибровка уверенности");
  });

  it("drops an answer that names an item that is not a candidate, as the worker does", async () => {
    const gateway = new TestAiGateway();
    gateway.matchOverride = (row) =>
      row.id === data.samples[0]!.id ? { itemId: "not-a-candidate", confidence: 0.99 } : undefined;
    const runner = new EvalWithoutDatabase(testAi(gateway, []), {} as DatabaseService);
    const run = await runner.run({ models: ["test/model-b"] });
    expect(run.results[0]!.answers[data.samples[0]!.id]).toBeUndefined();
    expect(run.results[0]!.score.answered).toBe(data.samples.length - 1);
  });
});
