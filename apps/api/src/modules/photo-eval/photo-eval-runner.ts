import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DatabaseService } from "../../database";
import {
  aiJob,
  AiBudgetExhaustedError,
  AiGatewayError,
  AiService,
  type AiCallMeta,
  type AiCallResult,
  type DashboardOutput,
  type PartPhotoOutput,
  type PhotoInput,
} from "../ai";
import { prepareDocumentImage } from "../vehicle-document";
import {
  loadDashboardEvalData,
  loadPartEvalData,
  photoEvalDirectory,
  type PhotoEvalKind,
} from "./photo-eval-data";
import { renderPhotoEvalRun } from "./photo-eval-report";
import {
  scoreDashboards,
  scoreParts,
  type DashboardScore,
  type PartScore,
} from "./photo-eval-score";

/**
 * The model comparison for the photos of TASK-058 (D-058): every picture of
 * a synthetic set is read once by each named model, prepared exactly as the
 * route prepares a photo, through `AiService` — so the run is held against
 * the daily budget, every call is in `ai_job`, and the model is the named
 * one, without a fallback. Development only: the operator command refuses
 * it anywhere else.
 */

export interface PhotoEvalFailure {
  sampleId: string;
  kind: string;
  message: string;
}

export interface PhotoEvalModelResult {
  model: string;
  answeredBy: string[];
  calls: number;
  failures: PhotoEvalFailure[];
  costUsd: number;
  costIsEstimate: boolean;
  costPerScanUsd: number;
  tokensIn: number;
  tokensOut: number;
  latencyMs: { min: number; median: number; max: number };
  score: DashboardScore | PartScore;
  /** What the model read, by sample — the material for a person to look at. */
  answers: Record<string, DashboardOutput | PartPhotoOutput>;
}

export interface PhotoEvalRun {
  kind: PhotoEvalKind;
  startedAt: string;
  finishedAt: string;
  dataVersion: number;
  samples: number;
  label?: string;
  provider: string;
  results: PhotoEvalModelResult[];
}

/** The daily budget stopped the comparison. */
export class PhotoEvalBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhotoEvalBudgetError";
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

@Injectable()
export class PhotoEval {
  private readonly logger = new Logger("AiEval");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(AiService) private readonly ai: AiService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async run(
    kind: PhotoEvalKind,
    options: { models: string[]; label?: string },
  ): Promise<PhotoEvalRun> {
    const data = kind === "dashboard" ? loadDashboardEvalData() : loadPartEvalData();
    const startedAt = new Date();
    const results: PhotoEvalModelResult[] = [];
    for (const model of options.models) {
      results.push(await this.runModel(kind, model, data.samples));
    }
    return {
      kind,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      dataVersion: data.version,
      samples: data.samples.length,
      ...(options.label === undefined ? {} : { label: options.label }),
      provider: this.ai.provider,
      results,
    };
  }

  private call(
    kind: PhotoEvalKind,
    input: PhotoInput,
    meta: AiCallMeta,
  ): Promise<AiCallResult<DashboardOutput | PartPhotoOutput>> {
    return kind === "dashboard"
      ? this.ai.readDashboard(input, meta)
      : this.ai.readPartPhoto(input, meta);
  }

  private async runModel(
    kind: PhotoEvalKind,
    model: string,
    samples: readonly { id: string; file: string }[],
  ): Promise<PhotoEvalModelResult> {
    const answers = new Map<string, DashboardOutput | PartPhotoOutput>();
    const failures: PhotoEvalFailure[] = [];
    const latencies: number[] = [];
    const answeredBy = new Set<string>();
    let calls = 0;
    let costUsd = 0;
    let costIsEstimate = false;
    let tokensIn = 0;
    let tokensOut = 0;
    const directory = photoEvalDirectory(kind);
    for (const sample of samples) {
      const image = await prepareDocumentImage(readFileSync(join(directory, sample.file)));
      calls += 1;
      const startedAt = Date.now();
      try {
        const result = await this.call(
          kind,
          { image: image.bytes, contentType: "image/jpeg" },
          {
            initiator: { type: "system" },
            inputRef: {
              eval: `${kind}-models`,
              model,
              sample: sample.id,
              bytes: image.bytes.byteLength,
            },
            model,
          },
        );
        latencies.push(Date.now() - startedAt);
        answeredBy.add(result.model);
        answers.set(sample.id, result.output);
        const [row] = await this.database.db.select().from(aiJob).where(eq(aiJob.id, result.jobId));
        costUsd += Number(row?.costUsd ?? 0);
        costIsEstimate ||= row?.costIsEstimate ?? false;
        tokensIn += row?.tokensIn ?? 0;
        tokensOut += row?.tokensOut ?? 0;
      } catch (error) {
        if (error instanceof AiBudgetExhaustedError) {
          throw new PhotoEvalBudgetError(error.message);
        }
        const failure = error instanceof AiGatewayError ? error.kind : "unknown";
        failures.push({
          sampleId: sample.id,
          kind: failure,
          message: error instanceof Error ? error.message : String(error),
        });
        // The same answer would come for every other picture.
        if (["no_private_provider", "model_unavailable", "rejected"].includes(failure)) break;
      }
    }
    const score =
      kind === "dashboard"
        ? scoreDashboards(loadDashboardEvalData().samples, answers as Map<string, DashboardOutput>)
        : scoreParts(loadPartEvalData().samples, answers as Map<string, PartPhotoOutput>);
    this.logger.log(
      `Model measured kind=${kind} model=${model} calls=${calls} failed=${failures.length} costUsd=${costUsd.toFixed(6)} passes=${String(score.passes)}`,
    );
    return {
      model,
      answeredBy: [...answeredBy],
      calls,
      failures,
      costUsd: Math.round(costUsd * 1e6) / 1e6,
      costIsEstimate,
      costPerScanUsd: answers.size === 0 ? 0 : Math.round((costUsd / answers.size) * 1e6) / 1e6,
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

/** Saves a run next to its set, as data and as a table. */
export function savePhotoEvalRun(run: PhotoEvalRun, name: string): string {
  const directory = join(photoEvalDirectory(run.kind), "results");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${name}.json`);
  writeFileSync(path, `${JSON.stringify(run, null, 2)}\n`, "utf8");
  writeFileSync(join(directory, `${name}.md`), renderPhotoEvalRun(run), "utf8");
  return path;
}
