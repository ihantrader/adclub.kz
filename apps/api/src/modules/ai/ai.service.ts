import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { describeError } from "../../common/health";
import { DatabaseService, withoutQueryParameters } from "../../database";
import { sanitizeForLog } from "../../observability";
import { AppSettings } from "../settings";
import {
  AiBudgetExhaustedError,
  AiGateway,
  AiGatewayError,
  FALLBACK_WORTHY,
  NOT_BILLED,
  translateOperation,
  type AiFailureKind,
  type AiOperation,
  type AiResult,
  type TranslateInput,
  type TranslateOutput,
} from "./ai-gateway";
import { aiJob, type AiJobRow } from "./schema";

/** Who a call is made for (`ai_job.initiator_type`); no personal data — an id at most. */
export type AiInitiator =
  { type: "system" } | { type: "account"; id: string } | { type: "guest_device"; id: string };

export const AI_SERVICE_OPTIONS = Symbol("AI_SERVICE_OPTIONS");

export interface AiServiceOptions {
  /** One attempt taking longer is cut and counts as `unavailable`. */
  timeoutMs: number;
}

export const defaultAiServiceOptions: AiServiceOptions = { timeoutMs: 60_000 };

export interface AiCallMeta {
  initiator: AiInitiator;
  /** What the call is about, without content: counts, kinds, ids. Stored in `ai_job.input_ref`. */
  inputRef: Record<string, unknown>;
  /**
   * Ask this one model instead of the operation's settings, and do not
   * fall back (TASK-053.B): the only caller is the model comparison, which
   * measures one named model at a time and must not silently record
   * another one's answer. Ordinary calls leave it out and take the models
   * of the operation from the settings (D-056).
   */
  model?: string;
}

export interface AiCallResult<Output> {
  /** The answer, checked against the operation's schema. */
  output: Output;
  /** The `ai_job` record of the call. */
  jobId: string;
  model: string;
  provider: string;
  /** The primary model could not answer and the fallback did (D-056). */
  usedFallback: boolean;
}

/** The day of the daily budget: an Almaty calendar day (ARCHITECTURE 13.3). */
const ALMATY_DAY_START = sql`(date_trunc('day', now() AT TIME ZONE 'Asia/Almaty') AT TIME ZONE 'Asia/Almaty')`;

/**
 * Admission to the daily budget is decided one call at a time: the check
 * and the reservation happen under this lock in one transaction, so two
 * workers at the limit see each other's holds (ARCHITECTURE 4.20 I189).
 */
const BUDGET_LOCK = sql`SELECT pg_advisory_xact_lock(hashtext('ai_budget'))`;

export interface AiBudgetState {
  budgetUsd: number;
  /** What the day costs so far: settled calls plus the holds of calls in flight. */
  spentUsd: number;
  /** Of that, held by calls still running (released when their real cost is known). */
  heldUsd: number;
  exhausted: boolean;
}

export interface AiStatus extends AiBudgetState {
  provider: string;
  /** Calls since the start of the Almaty day by kind and status. */
  today: { kind: string; status: string; calls: number }[];
  /** Calls of the day whose recorded cost is this deployment's estimate, not the provider's number. */
  estimatedCostCalls: number;
  /** The failed calls of the day (never their content). */
  recentFailures: {
    id: string;
    kind: string;
    model: string;
    errorKind: string | null;
    error: string | null;
    at: string;
  }[];
}

const BLOCKED_LOG_INTERVAL_MS = 60_000;
const ERROR_TEXT_MAX = 500;
const RECENT_FAILURES = 10;

/**
 * Every call to AI goes through here (ARCHITECTURE 4.19, 4.20): the model
 * of the operation is read from the settings (D-056) and the fallback is
 * used when the first one cannot answer, a hold is taken against the daily
 * budget before anything is sent, the call is recorded in `ai_job` (kind,
 * provider, model, initiator, status, tokens, cost, duration, a safe error
 * text), an attempt taking too long is cut, and the answer is checked
 * against the schema of the operation before the caller sees it. The
 * gateway behind it (`AiGateway`) only talks to the provider.
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger("Ai");
  private lastBlockedLog = 0;

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(AiGateway) private readonly gateway: AiGateway,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(AI_SERVICE_OPTIONS) private readonly options: AiServiceOptions,
  ) {}

  get provider(): string {
    return this.gateway.provider;
  }

  translate(input: TranslateInput, meta: AiCallMeta): Promise<AiCallResult<TranslateOutput>> {
    return this.call(translateOperation, input, meta);
  }

  /**
   * One call: models, hold, record, provider (the fallback if the first
   * model cannot answer), check, record the outcome. Throws
   * `AiBudgetExhaustedError` (nothing sent, nothing recorded) or
   * `AiGatewayError` (recorded as failed).
   */
  async call<Input, Output>(
    operation: AiOperation<Input, Output>,
    input: Input,
    meta: AiCallMeta,
  ): Promise<AiCallResult<Output>> {
    const models: [string, ...string[]] =
      meta.model === undefined ? await this.modelsOf(operation) : [meta.model];
    const { jobId, reservationUsd } = await this.reserve(operation, meta, models[0]);
    const startedAt = Date.now();
    let failure: AiGatewayError | undefined;
    let result: AiResult | undefined;
    let tried = 0;
    for (const [index, model] of models.entries()) {
      const isFallback = index > 0;
      tried = index;
      const attempt = await this.attempt(operation, input, model);
      // An answer that came and was refused still cost money: its usage is
      // recorded either way, so the day's budget counts it (4.19 I175).
      result = attempt.result ?? result;
      if (attempt.ok) {
        await this.finish(jobId, startedAt, reservationUsd, {
          status: "succeeded",
          result: attempt.result,
          isFallback,
        });
        this.logger.log(
          `AI call succeeded job=${jobId} kind=${operation.kind} provider=${this.gateway.provider} model=${attempt.result.model} fallback=${String(isFallback)} tokensIn=${attempt.result.usage.tokensIn} tokensOut=${attempt.result.usage.tokensOut} costUsd=${String(attempt.result.usage.costUsd)} durationMs=${Date.now() - startedAt}`,
        );
        return {
          output: attempt.output,
          jobId,
          model: attempt.result.model,
          provider: this.gateway.provider,
          usedFallback: isFallback,
        };
      }
      failure = attempt.error;
      const more = index < models.length - 1 && FALLBACK_WORTHY.includes(failure.kind);
      this.logger.warn(
        `AI attempt failed job=${jobId} kind=${operation.kind} model=${model} fallback=${String(isFallback)} error=${failure.kind}: ${this.safeText(failure)}${more ? " — trying the fallback model" : ""}`,
      );
      if (!more) {
        break;
      }
    }
    const error = failure ?? new AiGatewayError("unavailable", "The AI call was not made");
    const text = this.safeText(error);
    await this.finish(jobId, startedAt, reservationUsd, {
      status: "failed",
      errorKind: error.kind,
      error: text,
      result,
      isFallback: tried > 0,
      model: models[tried]!,
    });
    this.logger.warn(
      `AI call failed job=${jobId} kind=${operation.kind} provider=${this.gateway.provider} error=${error.kind}: ${text}`,
    );
    throw error;
  }

  /** The day's budget, what it has cost and what is held by calls in flight (Almaty day). */
  async budget(): Promise<AiBudgetState> {
    const budgetUsd = await this.settings.get("ai_daily_budget_usd");
    const result = await this.database.db.execute<{ spent: string; held: string }>(
      sql`SELECT COALESCE(sum(${aiJob.costUsd}), 0)::text AS spent,
                 COALESCE(sum(${aiJob.costUsd}) FILTER (WHERE ${aiJob.status} = 'running'), 0)::text AS held
          FROM ${aiJob} WHERE ${aiJob.createdAt} >= ${ALMATY_DAY_START}`,
    );
    const spentUsd = Number(result.rows[0]?.spent ?? 0);
    return {
      budgetUsd,
      spentUsd,
      heldUsd: Number(result.rows[0]?.held ?? 0),
      exhausted: spentUsd >= budgetUsd,
    };
  }

  /** For the operator: budget, today's calls by kind and status, the failures of the day. */
  async status(): Promise<AiStatus> {
    const budget = await this.budget();
    const today = await this.database.db.execute<{ kind: string; status: string; calls: string }>(
      sql`SELECT ${aiJob.kind} AS kind, ${aiJob.status} AS status, count(*)::text AS calls FROM ${aiJob} WHERE ${aiJob.createdAt} >= ${ALMATY_DAY_START} GROUP BY 1, 2 ORDER BY 1, 2`,
    );
    const estimated = await this.database.db.execute<{ calls: string }>(
      sql`SELECT count(*)::text AS calls FROM ${aiJob}
          WHERE ${aiJob.createdAt} >= ${ALMATY_DAY_START} AND ${aiJob.costIsEstimate}`,
    );
    // The day's failures only: yesterday's trouble must not look like today's.
    const failures: AiJobRow[] = await this.database.db
      .select()
      .from(aiJob)
      .where(and(eq(aiJob.status, "failed"), gte(aiJob.createdAt, ALMATY_DAY_START)))
      .orderBy(desc(aiJob.createdAt))
      .limit(RECENT_FAILURES);
    return {
      ...budget,
      provider: this.gateway.provider,
      today: today.rows.map((row) => ({ ...row, calls: Number(row.calls) })),
      estimatedCostCalls: Number(estimated.rows[0]?.calls ?? 0),
      recentFailures: failures.map((row) => ({
        id: row.id,
        kind: row.kind,
        model: row.model,
        errorKind: row.errorKind,
        error: row.error,
        at: row.createdAt.toISOString(),
      })),
    };
  }

  /**
   * The models of an operation as the settings have them now (D-056):
   * the primary one, and the fallback when it is a different model.
   */
  private async modelsOf<Input, Output>(
    operation: AiOperation<Input, Output>,
  ): Promise<[string, ...string[]]> {
    const [primary, fallback] = await Promise.all([
      this.settings.get(operation.models.primary),
      this.settings.get(operation.models.fallback),
    ]);
    const first = String(primary);
    const second = String(fallback);
    return second && second !== first ? [first, second] : [first];
  }

  /**
   * One attempt at one model, cut if it takes longer than allowed, checked
   * against the schema. A refused answer is returned with what it cost —
   * the provider was paid for it whether or not it is usable.
   */
  private async attempt<Input, Output>(
    operation: AiOperation<Input, Output>,
    input: Input,
    model: string,
  ): Promise<
    | { ok: true; output: Output; result: AiResult }
    | { ok: false; error: AiGatewayError; result: AiResult | undefined }
  > {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(
        new AiGatewayError(
          "unavailable",
          `The AI call took longer than ${this.options.timeoutMs} ms`,
        ),
      );
    }, this.options.timeoutMs);
    try {
      let result: AiResult;
      try {
        result = await operation.invoke(this.gateway, input, model, controller.signal);
      } catch (error) {
        const failure = this.asGatewayError(error, controller.signal);
        return {
          ok: false,
          error: failure,
          // An answer the gateway could not use was still paid for: what it
          // cost is recorded, not the reservation (TASK-053.A).
          result: failure.usage ? { output: undefined, model, usage: failure.usage } : undefined,
        };
      }
      const parsed = operation.outputSchema.safeParse(result.output);
      if (!parsed.success) {
        // The issues name paths and rules, never the values.
        const paths = parsed.error.issues.map((issue) => issue.path.join(".") || "(root)");
        return {
          ok: false,
          error: new AiGatewayError(
            "invalid_output",
            `The answer does not match the schema at ${paths.slice(0, 5).join(", ")}`,
          ),
          result,
        };
      }
      return { ok: true, output: parsed.data, result };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Admission to the daily budget and the record of the call, in one
   * transaction under `BUDGET_LOCK`: the day's cost is read with the holds
   * of the calls in flight included, and the new call takes its own hold
   * before anything is sent. So calls running at the same time, in this
   * process or another, see each other, and the day can go over the budget
   * by at most what one admitted call really costs (I189).
   */
  private async reserve<Input, Output>(
    operation: AiOperation<Input, Output>,
    meta: AiCallMeta,
    model: string,
  ): Promise<{ jobId: string; reservationUsd: number }> {
    const [budgetUsd, reservationUsd] = await Promise.all([
      this.settings.get("ai_daily_budget_usd"),
      this.settings.get("ai_call_reservation_usd"),
    ]);
    return this.database.db.transaction(async (tx) => {
      await tx.execute(BUDGET_LOCK);
      const sums = await tx.execute<{ spent: string }>(
        sql`SELECT COALESCE(sum(${aiJob.costUsd}), 0)::text AS spent FROM ${aiJob} WHERE ${aiJob.createdAt} >= ${ALMATY_DAY_START}`,
      );
      const spentUsd = Number(sums.rows[0]?.spent ?? 0);
      if (spentUsd >= budgetUsd) {
        const now = Date.now();
        if (now - this.lastBlockedLog >= BLOCKED_LOG_INTERVAL_MS) {
          this.lastBlockedLog = now;
          this.logger.warn(
            `AI daily budget exhausted, the call is not sent kind=${operation.kind} spentUsd=${spentUsd} budgetUsd=${budgetUsd}`,
          );
        }
        throw new AiBudgetExhaustedError(spentUsd, budgetUsd);
      }
      const [row] = await tx
        .insert(aiJob)
        .values({
          kind: operation.kind,
          provider: this.gateway.provider,
          model,
          initiatorType: meta.initiator.type,
          initiatorId: meta.initiator.type === "system" ? null : meta.initiator.id,
          inputRef: meta.inputRef,
          status: "running",
          costUsd: String(reservationUsd),
          costIsEstimate: true,
        })
        .returning({ id: aiJob.id });
      return { jobId: row!.id, reservationUsd };
    });
  }

  /**
   * Closes the record: what the call cost according to the provider, or —
   * when the provider did not say — the hold it took, kept and flagged, so
   * an unknown cost is never counted as nothing (TASK-053 requirement 3).
   * A failure the provider decided before serving anything (`NOT_BILLED`)
   * is the one case where the cost is known to be zero.
   */
  private async finish(
    jobId: string,
    startedAt: number,
    reservationUsd: number,
    outcome:
      | { status: "succeeded"; result: AiResult; isFallback: boolean }
      | {
          status: "failed";
          errorKind: AiFailureKind;
          error: string;
          result: AiResult | undefined;
          isFallback: boolean;
          model: string;
        },
  ): Promise<void> {
    const usage = outcome.result?.usage;
    const known = usage?.costUsd !== null && usage?.costUsd !== undefined;
    // Nothing was served and nothing was answered: the call is free, not unknown.
    const notBilled =
      outcome.status === "failed" &&
      outcome.result === undefined &&
      NOT_BILLED.includes(outcome.errorKind);
    const model =
      outcome.status === "succeeded"
        ? outcome.result.model
        : (outcome.result?.model ?? outcome.model);
    try {
      await this.database.db
        .update(aiJob)
        .set({
          status: outcome.status,
          model,
          isFallback: outcome.isFallback,
          ...(outcome.status === "failed"
            ? { errorKind: outcome.errorKind, error: outcome.error }
            : {}),
          tokensIn: usage?.tokensIn ?? null,
          tokensOut: usage?.tokensOut ?? null,
          costUsd: known ? String(usage.costUsd) : notBilled ? "0" : String(reservationUsd),
          costIsEstimate: !known && !notBilled,
          latencyMs: Date.now() - startedAt,
          finishedAt: new Date(),
        })
        .where(eq(aiJob.id, jobId));
      if (!known && outcome.status === "succeeded") {
        this.logger.warn(
          `AI call without a cost from the provider job=${jobId} model=${outcome.result.model}: the day counts the reserved $${reservationUsd} for it (operator ai:status shows estimatedCostCalls)`,
        );
      }
    } catch (error) {
      // The call happened; the caller gets its outcome even if the record can't be completed.
      this.logger.error(
        `AI call record not completed job=${jobId}: ${describeError(withoutQueryParameters(error))}`,
      );
    }
  }

  private safeText(error: unknown): string {
    return sanitizeForLog(describeError(withoutQueryParameters(error))).slice(0, ERROR_TEXT_MAX);
  }

  private asGatewayError(error: unknown, signal?: AbortSignal): AiGatewayError {
    if (error instanceof AiGatewayError) {
      return error;
    }
    if (signal?.aborted && signal.reason instanceof AiGatewayError) {
      return signal.reason;
    }
    return new AiGatewayError("unavailable", `The AI call failed: ${describeError(error)}`, {
      cause: error,
    });
  }
}
