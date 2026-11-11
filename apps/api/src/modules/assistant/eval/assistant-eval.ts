import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { AssistantIntent, AssistantMessageKind, CatalogLanguage } from "@adclub/contracts";
import { claimsDiagnosis, warrantyTextContacts } from "@adclub/domain";
import { inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { DatabaseService } from "../../../database";
import { aiJob, AiService } from "../../ai";
import { category } from "../../catalog";
import { ShowcaseService } from "../../showcase";
import { carWordsOf } from "../assistant-car";
import { AssistantPipeline } from "../assistant-pipeline";
import type { AssistantMessageRow } from "../schema";
import { resolveVehicle } from "../../compatibility";

/**
 * The model comparison of the assistant (TASK-062; D-058): every scenario of
 * `ai-eval/assistant/scenarios.json` is played through the very pipeline the
 * route runs (`AssistantPipeline`: the rules, the tools over the catalog of
 * this database, grounding and the server's checks) with one named model and
 * no fallback, as a guest without club access. A question asked when the
 * scenario has no message left is answered by its `followUp`. Development
 * only, with the real key: the operator command refuses it elsewhere, and
 * the daily budget stops it.
 */

const carSchema = z.object({
  make: z.string(),
  model: z.string(),
  generation: z.string().optional(),
  engine: z.string().optional(),
  year: z.number().int().optional(),
});

const scenarioSchema = z.object({
  id: z.string(),
  lang: z.enum(["kk", "ru", "en"]),
  car: z.string(),
  city: z.string().nullable(),
  messages: z.array(z.string()).min(1),
  followUp: z.string().optional(),
  expect: z.object({
    intent: z.enum(["pick_by_params", "maintenance", "symptom", "other"]),
    /** Other intents that are right too (a booking of an oil change is a pick and a maintenance). */
    alsoIntents: z.array(z.enum(["pick_by_params", "maintenance", "symptom", "other"])).optional(),
    kind: z.enum(["answer", "question", "off_topic"]).optional(),
    categories: z.array(z.string()),
    needsItems: z.boolean().optional(),
    groups: z.boolean().optional(),
    noDiagnosis: z.boolean().optional(),
    noContacts: z.boolean().optional(),
    notFoundOk: z.boolean().optional(),
  }),
});

const fileSchema = z.object({
  version: z.number().int(),
  cars: z.record(z.string(), carSchema),
  followUp: z.record(z.enum(["kk", "ru", "en"]), z.string()),
  scenarios: z.array(scenarioSchema).min(1),
});

export type AssistantScenario = z.infer<typeof scenarioSchema>;

export interface ScenarioOutcome {
  id: string;
  turns: number;
  kind: AssistantMessageKind | "error";
  intent: AssistantIntent | null;
  intentOk: boolean;
  /** Every card of the last answer is of an allowed subcategory (the server's diagnostics too). */
  itemsOk: boolean;
  /** An answer that should have items had some. */
  hadItems: boolean;
  /** Item ids grounding dropped over the dialog. */
  dropped: number;
  /** The raw text of the model claimed a diagnosis (the server replaced it). */
  claimedDiagnosis: boolean;
  /** The raw text of the model carried a contact (the server dropped it). */
  wroteContacts: boolean;
  disclaimer: boolean;
  costUsd: number;
  latencyMs: number;
  error?: string;
  text: string;
  categories: string[];
}

export interface AssistantEvalModelResult {
  model: string;
  scenarios: ScenarioOutcome[];
  summary: {
    scenarios: number;
    intentShare: number;
    itemsShare: number;
    droppedTotal: number;
    symptomScenarios: number;
    diagnosisClaims: number;
    offTopicRefused: string;
    errors: number;
    turnsAvg: number;
    costPerDialogUsd: { avg: number; max: number };
    latencyMs: { median: number; max: number };
    costUsd: number;
    passes: boolean;
  };
}

export interface AssistantEvalRun {
  startedAt: string;
  finishedAt: string;
  dataVersion: number;
  label?: string;
  provider: string;
  results: AssistantEvalModelResult[];
}

/** Thresholds of D-058 for the assistant (TASK-062 requirement 4). */
export const ASSISTANT_EVAL_THRESHOLDS = {
  intentShare: 0.9,
  itemsShare: 0.95,
  diagnosisClaims: 0,
  costPerDialogUsd: 0.05,
};

/** The repository's `ai-eval/assistant`. */
export function assistantEvalDirectory(): string {
  let directory = __dirname;
  for (let depth = 0; depth < 12; depth += 1) {
    try {
      readFileSync(join(directory, "pnpm-workspace.yaml"));
      return join(directory, "ai-eval", "assistant");
    } catch {
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  throw new Error("ai-eval/assistant not found above the API");
}

export function loadAssistantScenarios(directory = assistantEvalDirectory()) {
  return fileSchema.parse(
    JSON.parse(readFileSync(join(directory, "scenarios.json"), "utf8")) as unknown,
  );
}

const median = (values: number[]) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};

@Injectable()
export class AssistantEval {
  private readonly logger = new Logger("AssistantEval");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AssistantPipeline) private readonly pipeline: AssistantPipeline,
    @Inject(ShowcaseService) private readonly showcase: ShowcaseService,
    @Inject(AiService) private readonly ai: AiService,
  ) {}

  async run(options: {
    models: readonly string[];
    label?: string;
    only?: readonly string[];
  }): Promise<AssistantEvalRun> {
    const file = loadAssistantScenarios();
    const scenarios = options.only
      ? file.scenarios.filter((scenario) => options.only!.includes(scenario.id))
      : file.scenarios;
    const startedAt = new Date().toISOString();
    const results: AssistantEvalModelResult[] = [];
    for (const model of options.models) {
      const outcomes: ScenarioOutcome[] = [];
      for (const scenario of scenarios) {
        outcomes.push(await this.play(model, scenario, file));
        this.logger.log(`model=${model} scenario=${scenario.id} done`);
      }
      results.push({ model, scenarios: outcomes, summary: summarize(outcomes, scenarios) });
    }
    return {
      startedAt,
      finishedAt: new Date().toISOString(),
      dataVersion: file.version,
      ...(options.label ? { label: options.label } : {}),
      provider: this.ai.provider,
      results,
    };
  }

  private async play(
    model: string,
    scenario: AssistantScenario,
    file: ReturnType<typeof loadAssistantScenarios>,
  ): Promise<ScenarioOutcome> {
    const executor = this.database.db;
    const started = Date.now();
    const car = await this.carOf(file.cars[scenario.car]!);
    const resolved = await resolveVehicle(executor, car);
    const words = await carWordsOf(executor, resolved);
    const cityId = scenario.city ? await this.cityOf(scenario.city) : null;
    const city = cityId
      ? await this.showcase.chosenCity(executor, cityId, scenario.lang as CatalogLanguage)
      : null;
    const viewer = await this.showcase.viewer(null);
    const history: AssistantMessageRow[] = [];
    const jobIds: string[] = [];
    let dropped = 0;
    let claimed = false;
    let contacts = false;
    const queue = [...scenario.messages];
    let followUps = 0;
    let last: Awaited<ReturnType<AssistantPipeline["turn"]>> | null = null;
    let turns = 0;
    let error: string | undefined;
    const dialogId = crypto.randomUUID();
    while (queue.length > 0 && turns < 4) {
      const text = queue.shift()!;
      turns += 1;
      try {
        last = await this.pipeline.turn({
          dialogId,
          context: { vehicle: car, resolved, cityId, viewer, lang: scenario.lang },
          car: words,
          cityName: city?.name.text ?? null,
          mileageKm: null,
          history,
          text,
          initiator: { type: "system" },
          model,
        });
      } catch (thrown) {
        error = String(thrown);
        break;
      }
      jobIds.push(...last.aiJobIds);
      for (const call of last.toolCalls) {
        if (call.name !== "propose" && call.name !== "ask_user") continue;
        const args = call.arguments as { text?: unknown; question?: unknown } | null;
        const raw = String(args?.text ?? args?.question ?? "");
        claimed ||= claimsDiagnosis(raw);
        contacts ||= warrantyTextContacts(raw).length > 0;
      }
      if (!last.ok) {
        error = `unavailable: ${last.reason}`;
        break;
      }
      dropped += last.dropped;
      const now = new Date();
      history.push(
        row(dialogId, "user", { text, createdAt: now }),
        row(dialogId, "assistant", {
          text: last.text,
          kind: last.kind,
          intent: last.intent,
          itemIds: last.itemIds,
          foundItemIds: last.foundIds,
          reply: last.reply,
          toolCalls: last.toolCalls,
          createdAt: now,
        }),
      );
      if (queue.length === 0 && last.kind === "question" && followUps < 2) {
        queue.push(
          followUps === 0 && scenario.followUp ? scenario.followUp : file.followUp[scenario.lang],
        );
        followUps += 1;
      }
    }
    const reply = last?.ok ? last : null;
    const categoryCodes = reply
      ? await this.codesOf(reply.reply.cards.map((card) => card.category.id))
      : [];
    const allowed = new Set([...scenario.expect.categories, "computer_diagnostics"]);
    const itemsOk = categoryCodes.every((code) => allowed.has(code));
    const hadItems = (reply?.reply.cards.length ?? 0) > 0;
    const intentOk =
      (reply?.intent !== null &&
        reply?.intent !== undefined &&
        [scenario.expect.intent, ...(scenario.expect.alsoIntents ?? [])].includes(reply.intent)) ||
      (scenario.expect.intent === "other" && reply?.kind === "off_topic");
    return {
      id: scenario.id,
      turns,
      kind: reply?.kind ?? "error",
      intent: reply?.intent ?? null,
      intentOk,
      itemsOk: reply !== null && itemsOk,
      hadItems,
      dropped,
      claimedDiagnosis: claimed,
      wroteContacts: contacts,
      disclaimer: reply?.reply.disclaimer !== null && reply?.reply.disclaimer !== undefined,
      costUsd: await this.costOf(jobIds),
      latencyMs: Date.now() - started,
      ...(error ? { error } : {}),
      text: reply?.text ?? "",
      categories: categoryCodes,
    };
  }

  private async carOf(car: z.infer<typeof carSchema>) {
    const id = async (query: ReturnType<typeof sql>) => {
      const result = await this.database.db.execute<{ id: string }>(query);
      const value = result.rows[0]?.id;
      if (!value) throw new Error("A car of the scenarios is not in the vehicle catalog");
      return value;
    };
    const makeId = await id(
      sql`SELECT make_id::text AS id FROM vehicle_make_spelling WHERE key = ${car.make}`,
    );
    const modelId = await id(
      sql`SELECT model_id::text AS id FROM vehicle_model_spelling WHERE key = ${car.model} AND make_id = ${makeId}::uuid`,
    );
    return {
      makeId,
      modelId,
      ...(car.generation
        ? {
            generationId: await id(
              sql`SELECT id::text AS id FROM vehicle_generation WHERE model_id = ${modelId}::uuid AND name_key = ${car.generation}`,
            ),
          }
        : {}),
      ...(car.engine
        ? {
            engineId: await id(
              sql`SELECT engine_id::text AS id FROM vehicle_engine_spelling WHERE key = ${car.engine}`,
            ),
          }
        : {}),
      ...(car.year ? { year: car.year } : {}),
    };
  }

  private async cityOf(code: string): Promise<string> {
    const result = await this.database.db.execute<{ id: string }>(
      sql`SELECT id::text AS id FROM city WHERE code = ${code}`,
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error(`No city ${code}`);
    return id;
  }

  private async codesOf(categoryIds: readonly string[]): Promise<string[]> {
    if (categoryIds.length === 0) return [];
    const rows = await this.database.db
      .select({ id: category.id, code: category.code })
      .from(category)
      .where(inArray(category.id, [...categoryIds]));
    const codeOf = new Map(rows.map((entry) => [entry.id, entry.code]));
    return categoryIds.map((id) => codeOf.get(id) ?? id);
  }

  private async costOf(jobIds: readonly string[]): Promise<number> {
    if (jobIds.length === 0) return 0;
    const rows = await this.database.db
      .select({ cost: aiJob.costUsd })
      .from(aiJob)
      .where(inArray(aiJob.id, [...jobIds]));
    return rows.reduce((sum, entry) => sum + Number(entry.cost ?? 0), 0);
  }
}

function row(
  dialogId: string,
  role: "user" | "assistant",
  values: Partial<AssistantMessageRow>,
): AssistantMessageRow {
  return {
    id: crypto.randomUUID(),
    dialogId,
    role,
    text: null,
    kind: null,
    intent: null,
    itemIds: [],
    foundItemIds: [],
    droppedItems: 0,
    reply: null,
    toolCalls: [],
    aiJobIds: [],
    anonymizedAt: null,
    createdAt: new Date(),
    ...values,
  };
}

function summarize(
  outcomes: readonly ScenarioOutcome[],
  scenarios: readonly AssistantScenario[],
): AssistantEvalModelResult["summary"] {
  const share = (count: number) =>
    outcomes.length === 0 ? 0 : Math.round((count / outcomes.length) * 1000) / 1000;
  const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  const itemsGood = outcomes.filter((outcome) => {
    const expect = byId.get(outcome.id)!.expect;
    if (!outcome.itemsOk) return false;
    if (expect.needsItems && !outcome.hadItems) return false;
    if (expect.categories.length === 0 && outcome.hadItems) return false;
    return true;
  }).length;
  const symptoms = outcomes.filter((outcome) => byId.get(outcome.id)!.expect.intent === "symptom");
  const offTopic = outcomes.filter((outcome) => byId.get(outcome.id)!.expect.kind === "off_topic");
  const costs = outcomes.map((outcome) => outcome.costUsd);
  const summary = {
    scenarios: outcomes.length,
    intentShare: share(outcomes.filter((outcome) => outcome.intentOk).length),
    itemsShare: share(itemsGood),
    droppedTotal: outcomes.reduce((sum, outcome) => sum + outcome.dropped, 0),
    symptomScenarios: symptoms.length,
    diagnosisClaims: outcomes.filter((outcome) => outcome.claimedDiagnosis).length,
    offTopicRefused: `${String(offTopic.filter((outcome) => outcome.kind === "off_topic").length)}/${String(offTopic.length)}`,
    errors: outcomes.filter((outcome) => outcome.error !== undefined).length,
    turnsAvg:
      Math.round(
        (outcomes.reduce((sum, outcome) => sum + outcome.turns, 0) / Math.max(1, outcomes.length)) *
          10,
      ) / 10,
    costPerDialogUsd: {
      avg: Math.round((costs.reduce((a, b) => a + b, 0) / Math.max(1, costs.length)) * 1e6) / 1e6,
      max: Math.round(Math.max(0, ...costs) * 1e6) / 1e6,
    },
    latencyMs: {
      median: median(outcomes.map((o) => o.latencyMs)),
      max: Math.max(0, ...outcomes.map((o) => o.latencyMs)),
    },
    costUsd: Math.round(costs.reduce((a, b) => a + b, 0) * 1e6) / 1e6,
  };
  return {
    ...summary,
    passes:
      summary.intentShare >= ASSISTANT_EVAL_THRESHOLDS.intentShare &&
      summary.itemsShare >= ASSISTANT_EVAL_THRESHOLDS.itemsShare &&
      summary.diagnosisClaims <= ASSISTANT_EVAL_THRESHOLDS.diagnosisClaims &&
      summary.costPerDialogUsd.avg <= ASSISTANT_EVAL_THRESHOLDS.costPerDialogUsd &&
      summary.errors === 0,
  };
}

/** The run as a table a person reads (`.md` next to the `.json`). */
export function renderAssistantEvalRun(run: AssistantEvalRun): string {
  const lines = [
    `# Замер моделей помощника — ${run.startedAt.slice(0, 10)}${run.label ? ` (${run.label})` : ""}`,
    "",
    `Провайдер: ${run.provider}. Порог (D-058): намерение ≥ 90 %, допустимые позиции ≥ 95 %, ни одного «диагноза» в тексте модели, стоимость диалога ≤ $0.05, без ошибок.`,
    "",
    "| Модель | Намерение | Допустимые позиции | Отброшено grounding | «Диагноз» модели | Не по теме — отказ | Ошибки | Ходов в среднем | Диалог, $ (ср./макс.) | Время, мс (медиана/макс.) | Всего, $ | Порог |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...run.results.map(
      ({ model, summary }) =>
        `| ${model} | ${String(Math.round(summary.intentShare * 100))} % | ${String(Math.round(summary.itemsShare * 100))} % | ${String(summary.droppedTotal)} | ${String(summary.diagnosisClaims)} из ${String(summary.symptomScenarios)} | ${summary.offTopicRefused} | ${String(summary.errors)} | ${String(summary.turnsAvg)} | ${summary.costPerDialogUsd.avg.toFixed(4)} / ${summary.costPerDialogUsd.max.toFixed(4)} | ${String(summary.latencyMs.median)} / ${String(summary.latencyMs.max)} | ${summary.costUsd.toFixed(4)} | ${summary.passes ? "да" : "нет"} |`,
    ),
    "",
  ];
  for (const result of run.results) {
    lines.push(
      `## ${result.model}`,
      "",
      "| Сценарий | Вид | Намерение | Подкатегории | Отброшено | Ходов | $ | Замечание |",
      "|---|---|---|---|---|---|---|---|",
    );
    for (const outcome of result.scenarios) {
      const notes = [
        outcome.intentOk ? null : "намерение",
        outcome.itemsOk ? null : "позиции",
        outcome.claimedDiagnosis ? "диагноз" : null,
        outcome.wroteContacts ? "контакты" : null,
        outcome.error ? `ошибка: ${outcome.error.slice(0, 60)}` : null,
      ].filter(Boolean);
      lines.push(
        `| ${outcome.id} | ${outcome.kind} | ${outcome.intent ?? "—"} | ${outcome.categories.join(", ") || "—"} | ${String(outcome.dropped)} | ${String(outcome.turns)} | ${outcome.costUsd.toFixed(4)} | ${notes.join("; ") || "—"} |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function saveAssistantEvalRun(run: AssistantEvalRun, name: string): string {
  const directory = join(assistantEvalDirectory(), "results");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${name}.json`);
  writeFileSync(path, `${JSON.stringify(run, null, 2)}\n`, "utf8");
  writeFileSync(join(directory, `${name}.md`), renderAssistantEvalRun(run), "utf8");
  return path;
}
