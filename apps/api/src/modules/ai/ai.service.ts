import { Inject, Injectable, Logger } from "@nestjs/common";
import { desc, eq, sql } from "drizzle-orm";
import { describeError } from "../../common/health";
import { DatabaseService, withoutQueryParameters } from "../../database";
import { sanitizeForLog } from "../../observability";
import { AppSettings } from "../settings";
import {
  AiBudgetExhaustedError,
  AiGateway,
  AiGatewayError,
  translateOperation,
  type AiFailureKind,
  type AiJobKind,
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
  /** A call taking longer is cut and counts as `unavailable`. */
  timeoutMs: number;
}

export const defaultAiServiceOptions: AiServiceOptions = { timeoutMs: 60_000 };

export interface AiCallMeta {
  initiator: AiInitiator;
  /** What the call is about, without content: counts, kinds, ids. Stored in `ai_job.input_ref`. */
  inputRef: Record<string, unknown>;
}

export interface AiCallResult<Output> {
  /** The answer, checked against the operation's schema. */
  output: Output;
  /** The `ai_job` record of the call. */
  jobId: string;
  model: string;
  provider: string;
}

/** The day of the daily budget: an Almaty calendar day (ARCHITECTURE 13.3). */
const ALMATY_DAY_START = sql`(date_trunc('day', now() AT TIME ZONE 'Asia/Almaty') AT TIME ZONE 'Asia/Almaty')`;

export interface AiBudgetState {
  budgetUsd: number;
  spentUsd: number;
  exhausted: boolean;
}

export interface AiStatus extends AiBudgetState {
  provider: string;
  /** Calls since the start of the Almaty day by kind and status. */
  today: { kind: string; status: string; calls: number }[];
  /** The latest failed calls (never their content). */
  recentFailures: {
    id: string;
    kind: string;
    errorKind: string | null;
    error: string | null;
    at: string;
  }[];
}

const BLOCKED_LOG_INTERVAL_MS = 60_000;
const ERROR_TEXT_MAX = 500;

/**
 * Every call to AI goes through here (ARCHITECTURE 4.19): the daily budget
 * is checked before anything is sent, the call is recorded in `ai_job`
 * (kind, provider, model, initiator, status, tokens, cost, duration, a
 * safe error text), a call taking too long is cut, and the answer is
 * checked against the schema of the operation before the caller sees it.
 * The gateway behind it (`AiGateway`) only talks to the provider.
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
   * One call: budget, record, provider, check, record the outcome. Throws
   * `AiBudgetExhaustedError` (nothing sent, nothing recorded) or
   * `AiGatewayError` (recorded as failed).
   */
  async call<Input, Output>(
    operation: AiOperation<Input, Output>,
    input: Input,
    meta: AiCallMeta,
  ): Promise<AiCallResult<Output>> {
    await this.assertBudget(operation.kind);
    const jobId = await this.begin(operation, meta);
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(
        new AiGatewayError(
          "unavailable",
          `The AI call took longer than ${this.options.timeoutMs} ms`,
        ),
      );
    }, this.options.timeoutMs);
    let result: AiResult | undefined;
    try {
      try {
        result = await operation.invoke(this.gateway, input, controller.signal);
      } catch (error) {
        throw this.asGatewayError(error, controller.signal);
      }
      const parsed = operation.outputSchema.safeParse(result.output);
      if (!parsed.success) {
        // The issues name paths and rules, never the values.
        const paths = parsed.error.issues.map((issue) => issue.path.join(".") || "(root)");
        throw new AiGatewayError(
          "invalid_output",
          `The answer does not match the schema at ${paths.slice(0, 5).join(", ")}`,
        );
      }
      await this.finish(jobId, startedAt, { status: "succeeded", result });
      this.logger.log(
        `AI call succeeded job=${jobId} kind=${operation.kind} provider=${this.gateway.provider} model=${result.model} tokensIn=${result.usage.tokensIn} tokensOut=${result.usage.tokensOut} costUsd=${String(result.usage.costUsd)} durationMs=${Date.now() - startedAt}`,
      );
      return {
        output: parsed.data,
        jobId,
        model: result.model,
        provider: this.gateway.provider,
      };
    } catch (error) {
      const failure = error instanceof AiGatewayError ? error : this.asGatewayError(error);
      const text = sanitizeForLog(describeError(withoutQueryParameters(failure))).slice(
        0,
        ERROR_TEXT_MAX,
      );
      await this.finish(jobId, startedAt, {
        status: "failed",
        errorKind: failure.kind,
        error: text,
        result,
      });
      this.logger.warn(
        `AI call failed job=${jobId} kind=${operation.kind} provider=${this.gateway.provider} error=${failure.kind}: ${text}`,
      );
      throw failure;
    } finally {
      clearTimeout(timer);
    }
  }

  /** The day's budget and spend (Almaty day). */
  async budget(): Promise<AiBudgetState> {
    const budgetUsd = await this.settings.get("ai_daily_budget_usd");
    const result = await this.database.db.execute<{ spent: string }>(
      sql`SELECT COALESCE(sum(${aiJob.costUsd}), 0)::text AS spent FROM ${aiJob} WHERE ${aiJob.createdAt} >= ${ALMATY_DAY_START}`,
    );
    const spentUsd = Number(result.rows[0]?.spent ?? 0);
    return { budgetUsd, spentUsd, exhausted: spentUsd >= budgetUsd };
  }

  /** For the operator: budget, today's calls by kind and status, the latest failures. */
  async status(): Promise<AiStatus> {
    const budget = await this.budget();
    const today = await this.database.db.execute<{ kind: string; status: string; calls: string }>(
      sql`SELECT ${aiJob.kind} AS kind, ${aiJob.status} AS status, count(*)::text AS calls FROM ${aiJob} WHERE ${aiJob.createdAt} >= ${ALMATY_DAY_START} GROUP BY 1, 2 ORDER BY 1, 2`,
    );
    const failures: AiJobRow[] = await this.database.db
      .select()
      .from(aiJob)
      .where(eq(aiJob.status, "failed"))
      .orderBy(desc(aiJob.createdAt))
      .limit(10);
    return {
      ...budget,
      provider: this.gateway.provider,
      today: today.rows.map((row) => ({ ...row, calls: Number(row.calls) })),
      recentFailures: failures.map((row) => ({
        id: row.id,
        kind: row.kind,
        errorKind: row.errorKind,
        error: row.error,
        at: row.createdAt.toISOString(),
      })),
    };
  }

  private async assertBudget(kind: AiJobKind): Promise<void> {
    const budget = await this.budget();
    if (!budget.exhausted) {
      return;
    }
    const now = Date.now();
    if (now - this.lastBlockedLog >= BLOCKED_LOG_INTERVAL_MS) {
      this.lastBlockedLog = now;
      this.logger.warn(
        `AI daily budget exhausted, the call is not sent kind=${kind} spentUsd=${budget.spentUsd} budgetUsd=${budget.budgetUsd}`,
      );
    }
    throw new AiBudgetExhaustedError(budget.spentUsd, budget.budgetUsd);
  }

  private async begin<Input, Output>(
    operation: AiOperation<Input, Output>,
    meta: AiCallMeta,
  ): Promise<string> {
    const [row] = await this.database.db
      .insert(aiJob)
      .values({
        kind: operation.kind,
        provider: this.gateway.provider,
        model: operation.model,
        initiatorType: meta.initiator.type,
        initiatorId: meta.initiator.type === "system" ? null : meta.initiator.id,
        inputRef: meta.inputRef,
        status: "running",
      })
      .returning({ id: aiJob.id });
    return row!.id;
  }

  private async finish(
    jobId: string,
    startedAt: number,
    outcome:
      | { status: "succeeded"; result: AiResult }
      | { status: "failed"; errorKind: AiFailureKind; error: string; result: AiResult | undefined },
  ): Promise<void> {
    const usage = outcome.result?.usage;
    try {
      await this.database.db
        .update(aiJob)
        .set({
          status: outcome.status,
          ...(outcome.result ? { model: outcome.result.model } : {}),
          ...(outcome.status === "failed"
            ? { errorKind: outcome.errorKind, error: outcome.error }
            : {}),
          tokensIn: usage?.tokensIn ?? null,
          tokensOut: usage?.tokensOut ?? null,
          costUsd: usage?.costUsd === null || usage === undefined ? null : String(usage.costUsd),
          latencyMs: Date.now() - startedAt,
          finishedAt: new Date(),
        })
        .where(eq(aiJob.id, jobId));
    } catch (error) {
      // The call happened; the caller gets its outcome even if the record can't be completed.
      this.logger.error(
        `AI call record not completed job=${jobId}: ${describeError(withoutQueryParameters(error))}`,
      );
    }
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
