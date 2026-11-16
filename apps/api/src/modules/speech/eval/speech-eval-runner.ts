import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { cleanSpeechText, readWav } from "@adclub/domain";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { DatabaseService } from "../../../database";
import { aiJob, AiBudgetExhaustedError, AiGatewayError, AiService } from "../../ai";
import { renderSpeechEvalRun } from "./speech-eval-report";
import { scoreSpeech, wordErrorRate, type SpeechScore } from "./speech-eval-score";

/**
 * The model comparison for voice input (TASK-059, D-058): every recording of
 * a set is heard once by each named model through `AiService` — so the run
 * is held against the daily budget, every call is in `ai_job` (its size and
 * length only), and the model is the named one, without a fallback.
 * Development only: the operator command refuses it anywhere else.
 *
 * Two sets: `synthetic` — `ai-eval/speech/samples.json`, Windows voices
 * (in git); `recordings` — `ai-eval/speech/recordings/recordings.json`,
 * people's voices (never in git; `recordings.example.json` is the format).
 */

export type SpeechEvalSet = "synthetic" | "recordings";

const sampleSchema = z.object({
  id: z.string().min(1),
  lang: z.string().nullable(),
  expected: z.array(z.string()).min(1),
  article: z.string().nullable().default(null),
  file: z.string().min(1),
  note: z.string().optional(),
});

const dataSchema = z.object({
  version: z.number().int(),
  samples: z.array(sampleSchema).min(1),
});

export type SpeechEvalSample = z.infer<typeof sampleSchema>;

/** `ai-eval/speech` of the repository: found above this file (pnpm-workspace.yaml). */
export function speechEvalDirectory(): string {
  let directory = __dirname;
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(directory, "pnpm-workspace.yaml")))
      return join(directory, "ai-eval", "speech");
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error("The repository root (pnpm-workspace.yaml) was not found above this file");
}

export function loadSpeechEvalData(set: SpeechEvalSet): {
  version: number;
  samples: SpeechEvalSample[];
  directory: string;
} {
  const root = speechEvalDirectory();
  const directory = set === "synthetic" ? root : join(root, "recordings");
  const file = join(directory, set === "synthetic" ? "samples.json" : "recordings.json");
  if (!existsSync(file)) {
    throw new Error(
      `${file} not found: put the recordings and their list there (format — ai-eval/speech/recordings.example.json)`,
    );
  }
  const data = dataSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  return { ...data, directory };
}

export interface SpeechEvalFailure {
  sampleId: string;
  kind: string;
  message: string;
}

export interface SpeechEvalModelResult {
  model: string;
  answeredBy: string[];
  calls: number;
  failures: SpeechEvalFailure[];
  costUsd: number;
  costIsEstimate: boolean;
  costPerRequestUsd: number;
  tokensIn: number;
  tokensOut: number;
  latencyMs: { min: number; median: number; max: number };
  score: SpeechScore;
  /** What the model heard (as it wrote it and as the line shows it), by sample, and its WER. */
  answers: Record<string, { raw: string; text: string; wer: number }>;
}

export interface SpeechEvalRun {
  set: SpeechEvalSet;
  startedAt: string;
  finishedAt: string;
  dataVersion: number;
  samples: number;
  /** The language of the interface sent as the hint with every recording. */
  languageHint: "kk" | "ru" | "en";
  label?: string;
  provider: string;
  results: SpeechEvalModelResult[];
}

/** The daily budget stopped the comparison. */
export class SpeechEvalBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpeechEvalBudgetError";
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
export class SpeechEval {
  private readonly logger = new Logger("AiEval");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(AiService) private readonly ai: AiService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async run(options: {
    models: string[];
    set?: SpeechEvalSet;
    label?: string;
    languageHint?: "kk" | "ru" | "en";
    only?: string[];
  }): Promise<SpeechEvalRun> {
    const set = options.set ?? "synthetic";
    const data = loadSpeechEvalData(set);
    const samples = options.only
      ? data.samples.filter((sample) => options.only!.includes(sample.id))
      : data.samples;
    const languageHint = options.languageHint ?? "ru";
    const startedAt = new Date();
    const results: SpeechEvalModelResult[] = [];
    for (const model of options.models) {
      results.push(await this.runModel(model, samples, data.directory, languageHint));
    }
    return {
      set,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      dataVersion: data.version,
      samples: samples.length,
      languageHint,
      ...(options.label === undefined ? {} : { label: options.label }),
      provider: this.ai.provider,
      results,
    };
  }

  private async runModel(
    model: string,
    samples: readonly SpeechEvalSample[],
    directory: string,
    language: "kk" | "ru" | "en",
  ): Promise<SpeechEvalModelResult> {
    const answers = new Map<string, string>();
    const raw = new Map<string, string>();
    const failures: SpeechEvalFailure[] = [];
    const latencies: number[] = [];
    const answeredBy = new Set<string>();
    let calls = 0;
    let costUsd = 0;
    let costIsEstimate = false;
    let tokensIn = 0;
    let tokensOut = 0;
    for (const sample of samples) {
      const audio = new Uint8Array(readFileSync(join(directory, sample.file)));
      const read = readWav(audio);
      if (!read.ok) {
        failures.push({ sampleId: sample.id, kind: "invalid_file", message: read.reason });
        continue;
      }
      calls += 1;
      const startedAt = Date.now();
      try {
        const result = await this.ai.transcribeSpeech(
          { audio, format: "wav", seconds: read.wav.seconds, language },
          {
            initiator: { type: "system" },
            inputRef: {
              eval: "speech-models",
              model,
              sample: sample.id,
              bytes: audio.byteLength,
              seconds: Math.round(read.wav.seconds * 10) / 10,
            },
            model,
          },
        );
        latencies.push(Date.now() - startedAt);
        answeredBy.add(result.model);
        // Scored as the search line gets it: cleaned by the server, as the route does.
        answers.set(sample.id, cleanSpeechText(result.output.text).text);
        raw.set(sample.id, result.output.text);
        const [row] = await this.database.db.select().from(aiJob).where(eq(aiJob.id, result.jobId));
        costUsd += Number(row?.costUsd ?? 0);
        costIsEstimate ||= row?.costIsEstimate ?? false;
        tokensIn += row?.tokensIn ?? 0;
        tokensOut += row?.tokensOut ?? 0;
      } catch (error) {
        if (error instanceof AiBudgetExhaustedError) {
          throw new SpeechEvalBudgetError(error.message);
        }
        const failure = error instanceof AiGatewayError ? error.kind : "unknown";
        failures.push({
          sampleId: sample.id,
          kind: failure,
          message: error instanceof Error ? error.message : String(error),
        });
        // The same answer would come for every other recording.
        if (["no_private_provider", "model_unavailable", "rejected"].includes(failure)) break;
      }
    }
    const score = scoreSpeech(samples, answers);
    this.logger.log(
      `Model measured kind=speech model=${model} calls=${calls} failed=${failures.length} costUsd=${costUsd.toFixed(6)} passes=${String(score.passes)}`,
    );
    return {
      model,
      answeredBy: [...answeredBy],
      calls,
      failures,
      costUsd: Math.round(costUsd * 1e6) / 1e6,
      costIsEstimate,
      costPerRequestUsd: answers.size === 0 ? 0 : Math.round((costUsd / answers.size) * 1e7) / 1e7,
      tokensIn,
      tokensOut,
      latencyMs: {
        min: latencies.length === 0 ? 0 : Math.min(...latencies),
        median: median(latencies),
        max: latencies.length === 0 ? 0 : Math.max(...latencies),
      },
      score,
      answers: Object.fromEntries(
        [...answers].map(([id, text]) => {
          const sample = samples.find((candidate) => candidate.id === id)!;
          return [
            id,
            {
              raw: raw.get(id) ?? "",
              text,
              wer: Math.round(wordErrorRate(text, sample.expected).rate * 1000) / 1000,
            },
          ];
        }),
      ),
    };
  }
}

/** Saves a run next to its set, as data and as a table. */
export function saveSpeechEvalRun(run: SpeechEvalRun, name: string): string {
  const base = speechEvalDirectory();
  // People's recordings stay out of git, and so do the results that quote them.
  const directory =
    run.set === "synthetic" ? join(base, "results") : join(base, "recordings", "results");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${name}.json`);
  writeFileSync(path, `${JSON.stringify(run, null, 2)}\n`, "utf8");
  writeFileSync(join(directory, `${name}.md`), renderSpeechEvalRun(run), "utf8");
  return path;
}
