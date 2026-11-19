import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DatabaseService } from "../../database";
import {
  aiJob,
  AiBudgetExhaustedError,
  AiGatewayError,
  AiService,
  type PriceMatchInput,
} from "../ai";
import {
  loadPriceMatchEvalData,
  priceMatchEvalDirectory,
  scorePriceMatch,
  type PriceMatchEvalAnswer,
  type PriceMatchEvalData,
  type PriceMatchScore,
} from "./price-match-score";

/**
 * The model comparison of `price_match` (TASK-065, D-058): every row of the
 * set goes to each named model in batches, exactly as the worker sends rows
 * (`PriceImportMatcher.askAi`: article, brand, name and the candidates —
 * name, brand, article, subcategory), through `AiService` — the run is held
 * against the daily budget, every call is in `ai_job`, and the model is the
 * named one, without a fallback. Development only: the operator command
 * refuses it anywhere else.
 */

/** Rows of one call, as `price_match_batch_size` sends them by default. */
export const PRICE_MATCH_EVAL_BATCH = 25;

export interface PriceMatchEvalModelResult {
  model: string;
  answeredBy: string[];
  calls: number;
  failures: { batch: number; kind: string; message: string }[];
  costUsd: number;
  costIsEstimate: boolean;
  costPerRowUsd: number;
  tokensIn: number;
  tokensOut: number;
  /** Per call. */
  latencyMs: { min: number; median: number; max: number };
  score: PriceMatchScore;
  /** What the model answered, by sample — the material for a person to look at. */
  answers: Record<string, PriceMatchEvalAnswer>;
}

export interface PriceMatchEvalRun {
  startedAt: string;
  finishedAt: string;
  dataVersion: number;
  samples: number;
  label?: string;
  provider: string;
  threshold: number;
  results: PriceMatchEvalModelResult[];
}

/** The daily budget stopped the comparison. */
export class PriceMatchEvalBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PriceMatchEvalBudgetError";
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1]! + sorted[middle]!) / 2)
    : sorted[middle]!;
}

/** The input of one batch: the rows with their candidates, keyed by the set's item keys. */
export function priceMatchEvalInput(
  data: PriceMatchEvalData,
  samples: PriceMatchEvalData["samples"],
): PriceMatchInput {
  const items = new Map(data.items.map((item) => [item.key, item]));
  return {
    rows: samples.map((sample) => ({
      id: sample.id,
      article: sample.article,
      brand: sample.brand,
      name: sample.name,
      candidates: sample.candidates.map((key) => {
        const item = items.get(key)!;
        return {
          id: item.key,
          name: item.name,
          brand: item.brand,
          article: item.article,
          category: item.category,
        };
      }),
    })),
  };
}

@Injectable()
export class PriceMatchEval {
  private readonly logger = new Logger("AiEval");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(AiService) private readonly ai: Pick<AiService, "matchPrices" | "provider">,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async run(options: {
    models: string[];
    label?: string;
    threshold?: number;
    data?: PriceMatchEvalData;
  }): Promise<PriceMatchEvalRun> {
    const data = options.data ?? loadPriceMatchEvalData();
    const threshold = options.threshold ?? 0.85;
    const startedAt = new Date();
    const results: PriceMatchEvalModelResult[] = [];
    for (const model of options.models) {
      results.push(await this.runModel(model, data, threshold));
    }
    return {
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      dataVersion: data.version,
      samples: data.samples.length,
      ...(options.label === undefined ? {} : { label: options.label }),
      provider: this.ai.provider,
      threshold,
      results,
    };
  }

  /** What a call cost and counted, from its `ai_job`. */
  protected async jobUsage(jobId: string) {
    const [row] = await this.database.db.select().from(aiJob).where(eq(aiJob.id, jobId));
    return {
      costUsd: Number(row?.costUsd ?? 0),
      costIsEstimate: row?.costIsEstimate ?? false,
      tokensIn: row?.tokensIn ?? 0,
      tokensOut: row?.tokensOut ?? 0,
    };
  }

  private async runModel(
    model: string,
    data: PriceMatchEvalData,
    threshold: number,
  ): Promise<PriceMatchEvalModelResult> {
    const answers = new Map<string, PriceMatchEvalAnswer>();
    const failures: PriceMatchEvalModelResult["failures"] = [];
    const latencies: number[] = [];
    const answeredBy = new Set<string>();
    let calls = 0;
    let costUsd = 0;
    let costIsEstimate = false;
    let tokensIn = 0;
    let tokensOut = 0;
    for (let start = 0, batch = 1; start < data.samples.length; start += PRICE_MATCH_EVAL_BATCH) {
      const samples = data.samples.slice(start, start + PRICE_MATCH_EVAL_BATCH);
      const input = priceMatchEvalInput(data, samples);
      const startedAt = Date.now();
      calls += 1;
      try {
        const result = await this.ai.matchPrices(input, {
          initiator: { type: "system" },
          inputRef: { eval: "price-match-models", model, batch, rows: samples.length },
          model,
        });
        latencies.push(Date.now() - startedAt);
        answeredBy.add(result.model);
        const usage = await this.jobUsage(result.jobId);
        costUsd += usage.costUsd;
        costIsEstimate ||= usage.costIsEstimate;
        tokensIn += usage.tokensIn;
        tokensOut += usage.tokensOut;
        const rowIds = new Set(samples.map((sample) => sample.id));
        for (const match of result.output.matches) {
          if (!rowIds.has(match.id) || answers.has(match.id)) continue;
          const candidates = samples.find((sample) => sample.id === match.id)!.candidates;
          // As the worker: an item that is not a candidate is no answer.
          if (match.itemId !== null && !candidates.includes(match.itemId)) continue;
          answers.set(match.id, {
            itemId: match.itemId,
            confidence: Math.min(
              1,
              Math.max(0, Number.isFinite(match.confidence) ? match.confidence : 0),
            ),
            explanation: match.explanation.slice(0, 300),
          });
        }
      } catch (error) {
        if (error instanceof AiBudgetExhaustedError) {
          throw new PriceMatchEvalBudgetError(error.message);
        }
        const failure = error instanceof AiGatewayError ? error.kind : "unknown";
        failures.push({
          batch,
          kind: failure,
          message: error instanceof Error ? error.message : String(error),
        });
        if (["no_private_provider", "model_unavailable", "rejected"].includes(failure)) break;
      }
      batch += 1;
    }
    const score = scorePriceMatch(data.samples, answers, threshold);
    this.logger.log(
      `Model measured kind=price-match model=${model} calls=${calls} failed=${failures.length} costUsd=${costUsd.toFixed(6)} accuracy=${String(score.accuracy)} passes=${String(score.passes)}`,
    );
    return {
      model,
      answeredBy: [...answeredBy],
      calls,
      failures,
      costUsd: Math.round(costUsd * 1e6) / 1e6,
      costIsEstimate,
      costPerRowUsd: answers.size === 0 ? 0 : Math.round((costUsd / answers.size) * 1e8) / 1e8,
      tokensIn,
      tokensOut,
      latencyMs: {
        min: latencies.length === 0 ? 0 : Math.min(...latencies),
        median: median(latencies),
        max: latencies.length === 0 ? 0 : Math.max(...latencies),
      },
      score,
      answers: Object.fromEntries(answers),
    };
  }
}

const percent = (value: number | null) => (value === null ? "—" : `${(value * 100).toFixed(1)} %`);

/** The run as a table for a person. */
export function renderPriceMatchEvalRun(run: PriceMatchEvalRun): string {
  const lines = [
    `# Сопоставление строк прайса (price_match) — ${run.startedAt.slice(0, 10)}${run.label ? ` · ${run.label}` : ""}`,
    "",
    `Набор v${String(run.dataVersion)}, строк: ${String(run.samples)}; провайдер: ${run.provider}; порог уверенности: ${String(run.threshold)}.`,
    "Порог D-058: точность ≥ 90 %, ложных совпадений ≤ 5 %.",
    "",
    "| Модель | Точность | Ложные | Пропущено | «Нет» верно | ≥ порога: верно | Цена прогона, $ | $ за строку | Время вызова, мс (мин/мед/макс) | Отказы | Проходит |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const result of run.results) {
    const s = result.score;
    lines.push(
      `| ${result.model} | ${percent(s.accuracy)} (${String(s.correct)}/${String(s.samples)}) | ${percent(s.falseMatchShare)} (${String(s.falseMatches)}) | ${String(s.missed)} | ${String(s.noneCorrect)}/${String(s.noneTotal)} | ${String(s.atThreshold.correct)}/${String(s.atThreshold.proposed)} (${percent(s.atThreshold.precision)}) | ${result.costUsd.toFixed(6)}${result.costIsEstimate ? " (оценка)" : ""} | ${result.costPerRowUsd.toFixed(8)} | ${String(result.latencyMs.min)}/${String(result.latencyMs.median)}/${String(result.latencyMs.max)} | ${String(result.failures.length)} | ${s.passes ? "да" : "нет"} |`,
    );
  }
  lines.push("", "## Калибровка уверенности (названные позиции)", "");
  lines.push("| Модель | 0,5–0,7 | 0,7–0,85 | 0,85–0,95 | ≥ 0,95 |", "|---|---|---|---|---|");
  for (const result of run.results) {
    lines.push(
      `| ${result.model} | ${result.score.buckets
        .map(
          (bucket) =>
            `${String(bucket.correct)}/${String(bucket.proposed)} (${percent(bucket.accuracy)})`,
        )
        .join(" | ")} |`,
    );
  }
  for (const result of run.results) {
    if (result.score.misses.length === 0) continue;
    lines.push("", `## Ошибки — ${result.model}`, "");
    for (const miss of result.score.misses) {
      lines.push(
        `- ${miss.sampleId}: ожидалось ${miss.expected ?? "«нет»"}, ответ ${miss.answered === undefined ? "— (строку пропустил)" : (miss.answered ?? "«нет»")}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Saves a run next to its set, as data and as a table. */
export function savePriceMatchEvalRun(run: PriceMatchEvalRun, name: string): string {
  const directory = join(priceMatchEvalDirectory(), "results");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${name}.json`);
  writeFileSync(path, `${JSON.stringify(run, null, 2)}\n`, "utf8");
  writeFileSync(join(directory, `${name}.md`), renderPriceMatchEvalRun(run), "utf8");
  return path;
}
