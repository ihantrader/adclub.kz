import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { TranslationTargetLanguage } from "@adclub/contracts";
import { eq, sql } from "drizzle-orm";
import { DatabaseService } from "../../../database";
import { maxLengthOf, translateContextOf } from "../translation-checks";
import {
  aiJob,
  AiBudgetExhaustedError,
  AiGatewayError,
  AiService,
  type TranslateItem,
} from "../../ai";
import {
  evalDataDirectory,
  loadEvalData,
  loadGlossary,
  type EvalData,
  type EvalSample,
} from "./eval-data";
import { renderEvalRun } from "./eval-report";
import { answerKey, checkRun, type QualityReport } from "./translation-quality";

/**
 * The model comparison (TASK-053.B, D-058): the sample set is translated
 * once by each named model and the same numbers are collected for all of
 * them — what the run cost by the provider's own figures, the tokens, the
 * time of an answer, the failures, and the machine checks of
 * `translation-quality`.
 *
 * It goes through `AiService` like every other call, so a run is held
 * against the daily budget and every call is in `ai_job`: the spend of a
 * comparison is visible in `operator ai:status` next to the project's
 * ordinary spend and cannot go past the budget. The model is named by the
 * caller instead of the settings (`AiCallMeta.model`), and no fallback is
 * tried — a comparison must measure the model it names.
 *
 * Development and tests only: the operator command refuses to run it
 * anywhere else, and nothing in the API or the worker starts it.
 */

export interface EvalRunOptions {
  models: string[];
  /** Texts per call; the running translation uses `translation_batch_size`. */
  batchSize: number;
  /** Send the term glossary with the texts (requirement 5). */
  glossary: boolean;
  languages: TranslationTargetLanguage[];
  /** A word for the saved result, e.g. `glossary`. */
  label?: string;
}

export interface EvalBatchFailure {
  batch: number;
  kind: string;
  message: string;
}

export interface EvalModelResult {
  model: string;
  /** The model that actually answered, as the provider named it. */
  answeredBy: string[];
  calls: number;
  /** Calls that gave no answer at all. */
  failedCalls: number;
  failures: EvalBatchFailure[];
  costUsd: number;
  costIsEstimate: boolean;
  tokensIn: number;
  tokensOut: number;
  latencyMs: { min: number; median: number; max: number };
  durationMs: number;
  quality: QualityReport | null;
  /** The translations, by `sampleId:lang` — the material for a person to read. */
  texts: Record<string, string>;
}

export interface EvalRun {
  startedAt: string;
  finishedAt: string;
  dataVersion: number;
  samples: number;
  options: Omit<EvalRunOptions, "models">;
  glossaryTerms: number;
  provider: string;
  results: EvalModelResult[];
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1]! + sorted[middle]!) / 2)
    : sorted[middle]!;
}

@Injectable()
export class TranslationEval {
  private readonly logger = new Logger("AiEval");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(AiService) private readonly ai: AiService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async run(options: EvalRunOptions): Promise<EvalRun> {
    const data = loadEvalData();
    const glossary = options.glossary ? loadGlossary() : [];
    const startedAt = new Date();
    const results: EvalModelResult[] = [];
    for (const model of options.models) {
      results.push(await this.runModel(model, data, options, glossary));
    }
    return {
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      dataVersion: data.version,
      samples: data.samples.length,
      options: {
        batchSize: options.batchSize,
        glossary: options.glossary,
        languages: options.languages,
        ...(options.label === undefined ? {} : { label: options.label }),
      },
      glossaryTerms: glossary.length,
      provider: this.ai.provider,
      results,
    };
  }

  private async runModel(
    model: string,
    data: EvalData,
    options: EvalRunOptions,
    glossary: ReturnType<typeof loadGlossary>,
  ): Promise<EvalModelResult> {
    const startedAt = Date.now();
    const answers = new Map<string, string>();
    const failures: EvalBatchFailure[] = [];
    const latencies: number[] = [];
    const answeredBy = new Set<string>();
    let calls = 0;
    let costUsd = 0;
    let costIsEstimate = false;
    let tokensIn = 0;
    let tokensOut = 0;
    let stopped = false;

    for (const [index, batch] of this.batches(data.samples, options.batchSize).entries()) {
      if (stopped) {
        break;
      }
      const items: TranslateItem[] = batch.map((sample) => ({
        id: sample.id,
        text: sample.text,
        context: translateContextOf(sample.entityType, sample.field),
        maxLength: maxLengthOf(sample.entityType, sample.field),
        languages: options.languages,
      }));
      const callStartedAt = Date.now();
      calls += 1;
      try {
        const result = await this.ai.translate(
          { items, ...(glossary.length > 0 && { glossary }) },
          {
            initiator: { type: "system" },
            inputRef: { eval: "translate-models", model, batch: index + 1, items: items.length },
            model,
          },
        );
        latencies.push(Date.now() - callStartedAt);
        answeredBy.add(result.model);
        for (const entry of result.output.translations) {
          answers.set(answerKey(entry.id, entry.lang), entry.text);
        }
        const usage = await this.usageOf(result.jobId);
        costUsd += usage.costUsd;
        costIsEstimate ||= usage.costIsEstimate;
        tokensIn += usage.tokensIn;
        tokensOut += usage.tokensOut;
      } catch (error) {
        if (error instanceof AiBudgetExhaustedError) {
          // The limit the operator set for the whole comparison: stop and
          // report, never keep spending (TASK-053.B requirement 3).
          failures.push({ batch: index + 1, kind: "budget_exhausted", message: error.message });
          throw new EvalBudgetError(error.message);
        }
        const kind = error instanceof AiGatewayError ? error.kind : "unknown";
        failures.push({
          batch: index + 1,
          kind,
          message: error instanceof Error ? error.message : String(error),
        });
        const usage = await this.usageOfFailed(model, index + 1);
        costUsd += usage.costUsd;
        tokensIn += usage.tokensIn;
        tokensOut += usage.tokensOut;
        // A model with no endpoint that keeps nothing (D-057), one
        // OpenRouter does not have, or one that refuses us will answer the
        // same for every other batch: it is marked unavailable and the
        // comparison goes on with the next model.
        if (["no_private_provider", "model_unavailable", "rejected"].includes(kind)) {
          stopped = true;
        }
      }
    }

    const quality =
      answers.size === 0 ? null : checkRun(data.samples, data.terms, answers, options.languages);
    this.logger.log(
      `Model measured model=${model} calls=${calls} failed=${failures.length} costUsd=${costUsd.toFixed(6)} problems=${quality?.problemTexts ?? "-"}`,
    );
    return {
      model,
      answeredBy: [...answeredBy],
      calls,
      failedCalls: failures.length,
      failures,
      costUsd: Math.round(costUsd * 1e6) / 1e6,
      costIsEstimate,
      tokensIn,
      tokensOut,
      latencyMs: {
        min: latencies.length === 0 ? 0 : Math.min(...latencies),
        median: median(latencies),
        max: latencies.length === 0 ? 0 : Math.max(...latencies),
      },
      durationMs: Date.now() - startedAt,
      quality,
      texts: Object.fromEntries(answers),
    };
  }

  private batches(samples: EvalSample[], size: number): EvalSample[][] {
    const batches: EvalSample[][] = [];
    for (let start = 0; start < samples.length; start += size) {
      batches.push(samples.slice(start, start + size));
    }
    return batches;
  }

  /** What the provider said the call cost, from its `ai_job` record. */
  private async usageOf(
    jobId: string,
  ): Promise<{ costUsd: number; costIsEstimate: boolean; tokensIn: number; tokensOut: number }> {
    const [row] = await this.database.db.select().from(aiJob).where(eq(aiJob.id, jobId));
    return {
      costUsd: Number(row?.costUsd ?? 0),
      costIsEstimate: row?.costIsEstimate ?? false,
      tokensIn: row?.tokensIn ?? 0,
      tokensOut: row?.tokensOut ?? 0,
    };
  }

  /**
   * What a failed call cost. `AiService` records it whether it succeeded
   * or not, and a refusal decided before anything was served costs
   * nothing — the comparison reports the same figures the budget counts.
   */
  private async usageOfFailed(
    model: string,
    batch: number,
  ): Promise<{ costUsd: number; tokensIn: number; tokensOut: number }> {
    const result = await this.database.db.execute<{
      cost_usd: string | null;
      tokens_in: number | null;
      tokens_out: number | null;
    }>(sql`
      SELECT cost_usd, tokens_in, tokens_out FROM ${aiJob}
      WHERE ${aiJob.status} = 'failed'
        AND ${aiJob.inputRef} @> ${JSON.stringify({ eval: "translate-models", model, batch })}::jsonb
      ORDER BY ${aiJob.createdAt} DESC LIMIT 1`);
    const row = result.rows[0];
    return {
      costUsd: Number(row?.cost_usd ?? 0),
      tokensIn: row?.tokens_in ?? 0,
      tokensOut: row?.tokens_out ?? 0,
    };
  }
}

/** The daily budget stopped the comparison; what ran is already saved. */
export class EvalBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalBudgetError";
  }
}

/**
 * Runs the checks again over a run that is already saved, without calling
 * anything: the texts are in the file, so a check that has been made
 * sharper can be applied to every past run for nothing, and the models
 * stay compared on one set of rules.
 */
export function recheckEvalRun(name: string): { path: string; models: string[] } {
  const directory = join(evalDataDirectory(), "results");
  const path = join(directory, `${name}.json`);
  const run = JSON.parse(readFileSync(path, "utf8")) as EvalRun;
  const data = loadEvalData();
  if (data.version !== run.dataVersion) {
    throw new Error(
      `The run was made with sample set version ${run.dataVersion} and the set is now version ${data.version}: the two are not comparable`,
    );
  }
  for (const result of run.results) {
    const answers = new Map(Object.entries(result.texts));
    result.quality =
      answers.size === 0
        ? null
        : checkRun(data.samples, data.terms, answers, run.options.languages);
  }
  saveEvalRun(run, name);
  return { path, models: run.results.map((result) => result.model) };
}

/** Saves a run as data next to the set, so the next review has something to compare with. */
export function saveEvalRun(run: EvalRun, name: string): string {
  const directory = join(evalDataDirectory(), "results");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${name}.json`);
  writeFileSync(path, `${JSON.stringify(run, null, 2)}\n`, "utf8");
  // The same run as a table: the JSON is the data, this is what a person reads.
  writeFileSync(join(directory, `${name}.md`), renderEvalRun(run), "utf8");
  return path;
}
