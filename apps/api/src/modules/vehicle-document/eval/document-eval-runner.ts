import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DatabaseService } from "../../../database";
import {
  aiJob,
  AiBudgetExhaustedError,
  AiGatewayError,
  AiService,
  type VehicleDocumentOutput,
} from "../../ai";
import { prepareDocumentImage } from "../document-image";
import {
  loadDocumentEvalData,
  vehicleDocumentEvalDirectory,
  type DocumentEvalData,
} from "./document-eval-data";
import { scoreDocuments, type DocumentScore } from "./document-eval-score";
import { renderDocumentEvalRun } from "./document-eval-report";

/**
 * The model comparison for reading a registration certificate (TASK-057
 * requirement 2, D-058): every picture of the synthetic set is read once by
 * each named model, prepared exactly as the route prepares a photo, through
 * `AiService` — so the run is held against the daily budget, every call is
 * in `ai_job`, and the model is the named one, without a fallback.
 * Development only: the operator command refuses it anywhere else.
 */

export interface DocumentEvalOptions {
  models: string[];
  label?: string;
}

export interface DocumentEvalFailure {
  sampleId: string;
  kind: string;
  message: string;
}

export interface DocumentEvalModelResult {
  model: string;
  answeredBy: string[];
  calls: number;
  failures: DocumentEvalFailure[];
  costUsd: number;
  costIsEstimate: boolean;
  costPerScanUsd: number;
  tokensIn: number;
  tokensOut: number;
  latencyMs: { min: number; median: number; max: number };
  score: DocumentScore;
  /** What the model read, by sample — the material for a person to look at. */
  answers: Record<string, VehicleDocumentOutput>;
}

export interface DocumentEvalRun {
  startedAt: string;
  finishedAt: string;
  dataVersion: number;
  samples: number;
  label?: string;
  provider: string;
  results: DocumentEvalModelResult[];
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1]! + sorted[middle]!) / 2)
    : sorted[middle]!;
}

/** The daily budget stopped the comparison. */
export class DocumentEvalBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentEvalBudgetError";
  }
}

@Injectable()
export class VehicleDocumentEval {
  private readonly logger = new Logger("AiEval");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(AiService) private readonly ai: AiService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async run(options: DocumentEvalOptions): Promise<DocumentEvalRun> {
    const data = loadDocumentEvalData();
    const startedAt = new Date();
    const results: DocumentEvalModelResult[] = [];
    for (const model of options.models) {
      results.push(await this.runModel(model, data));
    }
    return {
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      dataVersion: data.version,
      samples: data.samples.length,
      ...(options.label === undefined ? {} : { label: options.label }),
      provider: this.ai.provider,
      results,
    };
  }

  private async runModel(model: string, data: DocumentEvalData): Promise<DocumentEvalModelResult> {
    const answers = new Map<string, VehicleDocumentOutput>();
    const failures: DocumentEvalFailure[] = [];
    const latencies: number[] = [];
    const answeredBy = new Set<string>();
    let calls = 0;
    let costUsd = 0;
    let costIsEstimate = false;
    let tokensIn = 0;
    let tokensOut = 0;
    const directory = vehicleDocumentEvalDirectory();
    for (const sample of data.samples) {
      const image = await prepareDocumentImage(readFileSync(join(directory, sample.file)));
      calls += 1;
      const startedAt = Date.now();
      try {
        const result = await this.ai.readVehicleDocument(
          { image: image.bytes, contentType: "image/jpeg" },
          {
            initiator: { type: "system" },
            inputRef: {
              eval: "vehicle-document-models",
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
          throw new DocumentEvalBudgetError(error.message);
        }
        const kind = error instanceof AiGatewayError ? error.kind : "unknown";
        failures.push({
          sampleId: sample.id,
          kind,
          message: error instanceof Error ? error.message : String(error),
        });
        // The same answer would come for every other picture.
        if (["no_private_provider", "model_unavailable", "rejected"].includes(kind)) break;
      }
    }
    const score = scoreDocuments(data.samples, answers);
    this.logger.log(
      `Model measured model=${model} calls=${calls} failed=${failures.length} costUsd=${costUsd.toFixed(6)} vin=${score.fields.vin.share} plate=${score.fields.plate.share} kind=${score.kind.share}`,
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

/** Saves a run next to the set, as data and as a table. */
export function saveDocumentEvalRun(run: DocumentEvalRun, name: string): string {
  const directory = join(vehicleDocumentEvalDirectory(), "results");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${name}.json`);
  writeFileSync(path, `${JSON.stringify(run, null, 2)}\n`, "utf8");
  writeFileSync(join(directory, `${name}.md`), renderDocumentEvalRun(run), "utf8");
  return path;
}
