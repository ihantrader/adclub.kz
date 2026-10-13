import { Inject, Injectable, Logger } from "@nestjs/common";
import { auditActions, auditEntities, type ReviewHoldReason } from "@adclub/contracts";
import { reviewRuleFindings, type ReviewRuleFinding } from "@adclub/domain";
import { and, asc, eq, notInArray, sql } from "drizzle-orm";
import { DatabaseService, type DbExecutor } from "../../database";
import {
  JobQueue,
  type JobHandler,
  type JobRunContext,
  type Sweeper,
  type SweepResult,
} from "../../jobs";
import { AiBudgetExhaustedError, AiGatewayError, AiService, FALLBACK_WORTHY } from "../ai";
import { AuditLog } from "../audit";
import { supplier, supplierMember } from "../identity";
import { AppSettings } from "../settings";
import { checkReviewJob } from "./review-jobs";
import { review, type ReviewRow } from "./schema";

/** The explanation of a contact found by the rules, for the administrator. */
const CONTACT_WORDS: Record<string, string> = {
  phone: "телефон",
  link: "ссылка",
  email: "e-mail",
};

const EXPLANATION_MAX = 300;

function ruleReason(finding: ReviewRuleFinding): ReviewHoldReason {
  return {
    kind: finding.kind,
    source: "rule",
    explanation:
      finding.kind === "contacts"
        ? finding.contacts.map((contact) => CONTACT_WORDS[contact] ?? contact).join(", ")
        : null,
  };
}

/** «Проверка недоступна» — the check could not be made, a person decides. */
export function checkUnavailableReason(explanation: string | null): ReviewHoldReason {
  return { kind: "check_unavailable", source: "system", explanation };
}

/**
 * The check of a review before it is published (TASK-049 requirement 1;
 * PRODUCT 13; ARCHITECTURE 4.69):
 *
 * 1. the deterministic rules (`reviewRuleFindings`: contacts, the name of the
 *    order's supplier, names of its employees) — anything found holds the
 *    review, and AI is not asked;
 * 2. AI (`AiService`, the operation `review_check`): profanity and insults,
 *    threats, personal data, advertising — a violation holds the review,
 *    none publishes it. AI never refuses: only an administrator does;
 * 3. AI out of reach, or the day's budget spent — the review keeps waiting
 *    in `checking` and the job comes back after `review_check_retry_seconds`;
 *    a review waiting longer than `review_check_max_wait_minutes` is held by
 *    the sweeper («проверка недоступна»). A failure no wait will cure (the
 *    provider refuses, no private endpoint) holds it at once.
 *
 * The verdict is written only if the review is still the one that was
 * checked (`checking`, the same version): an administrator's or the
 * sweeper's move in the meantime wins, and a corrected text is checked anew.
 * The text never leaves this process but to the provider; it is never logged
 * nor written to the journal.
 */
@Injectable()
export class ReviewChecker implements JobHandler<{ reviewId: string }> {
  private readonly logger = new Logger("Reviews");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AiService) private readonly ai: AiService,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(JobQueue) private readonly queue: JobQueue,
    @Inject(AuditLog) private readonly audit: AuditLog,
  ) {}

  async run({ reviewId }: { reviewId: string }, _context: JobRunContext): Promise<void> {
    const [row] = await this.database.db.select().from(review).where(eq(review.id, reviewId));
    if (!row || row.status !== "checking" || row.text === null) {
      return;
    }
    const findings = reviewRuleFindings(row.text, await this.ruleContext(row.supplierId));
    if (findings.length > 0) {
      await this.settle(row, findings.map(ruleReason));
      return;
    }
    let violations;
    try {
      const answer = await this.ai.checkReview(
        { text: row.text, score: row.score },
        {
          initiator: { type: "account", id: row.userAccountId },
          inputRef: { reviewId: row.id, chars: row.text.length },
        },
      );
      violations = answer.output.violations;
    } catch (error) {
      if (
        error instanceof AiBudgetExhaustedError ||
        (error instanceof AiGatewayError &&
          (FALLBACK_WORTHY.includes(error.kind) || error.kind === "invalid_output"))
      ) {
        await this.later(row, error instanceof AiBudgetExhaustedError ? "budget" : error.kind);
        return;
      }
      if (error instanceof AiGatewayError) {
        await this.settle(row, [checkUnavailableReason(`ИИ: ${error.kind}`)]);
        return;
      }
      throw error;
    }
    const seen = new Set<string>();
    const reasons: ReviewHoldReason[] = [];
    for (const violation of violations) {
      if (seen.has(violation.kind)) continue;
      seen.add(violation.kind);
      reasons.push({
        kind: violation.kind,
        source: "ai",
        explanation: violation.explanation.trim().slice(0, EXPLANATION_MAX) || null,
      });
    }
    await this.settle(row, reasons);
  }

  /** The names the rules look for: the supplier's, its employees' and its contact's. */
  private async ruleContext(supplierId: string) {
    const db = this.database.db;
    const [company] = await db
      .select({ name: supplier.name, contactName: supplier.contactName })
      .from(supplier)
      .where(eq(supplier.id, supplierId));
    const members = await db
      .select({ name: supplierMember.displayName })
      .from(supplierMember)
      .where(eq(supplierMember.supplierId, supplierId));
    return {
      supplierNames: company ? [company.name] : [],
      employeeNames: [
        ...members.map((member) => member.name),
        ...(company?.contactName ? [company.contactName] : []),
      ],
    };
  }

  /** The verdict: no reasons — published; reasons — held for the administrator. */
  private async settle(row: ReviewRow, reasons: ReviewHoldReason[]): Promise<void> {
    const held = reasons.length > 0;
    const written = await this.database.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(review)
        .set({
          status: held ? "held" : "published",
          holdReasons: reasons,
          checkingSince: null,
          ...(held ? {} : { publishedAt: sql`now()` }),
          version: sql`${review.version} + 1`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(review.id, row.id),
            eq(review.status, "checking"),
            eq(review.version, row.version),
          ),
        )
        .returning({ id: review.id });
      if (!updated) {
        return false;
      }
      await this.audit.record(
        {
          action: auditActions.reviewChecked,
          actor: { role: "system" },
          entityType: auditEntities.review,
          entityId: row.id,
          before: { status: "checking" },
          after: {
            status: held ? "held" : "published",
            reasons: reasons.map((reason) => `${reason.source}:${reason.kind}`),
            orderId: row.orderId,
            supplierId: row.supplierId,
            accountId: row.userAccountId,
          },
        },
        tx,
      );
      return true;
    });
    if (written) {
      this.logger.log(
        `Review checked review=${row.id} status=${held ? "held" : "published"} reasons=${reasons.map((reason) => reason.kind).join(",") || "none"}`,
      );
    }
  }

  /** AI can't answer now: the review keeps waiting and the check comes back by itself. */
  private async later(row: ReviewRow, why: string): Promise<void> {
    const seconds = await this.settings.get("review_check_retry_seconds");
    await this.queue.enqueue(
      checkReviewJob,
      { reviewId: row.id },
      { singletonKey: row.id, startAfter: new Date(Date.now() + seconds * 1000) },
    );
    this.logger.warn(
      `Review check waits for AI review=${row.id} reason=${why} retryInSeconds=${String(seconds)}`,
    );
  }
}

/**
 * Every minute (`reviews.expire-checks`): a review whose text has waited for
 * its check longer than `review_check_max_wait_minutes` goes to the
 * administrator — `held` with «проверка недоступна» (A-REV-01: «если проверка
 * недоступна, отзыв ждёт; дольше порога — попадает в очередь»). The clock is
 * the database's.
 */
@Injectable()
export class ReviewCheckExpiry implements Sweeper<number> {
  private readonly logger = new Logger("Reviews");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(AuditLog) private readonly audit: AuditLog,
  ) {}

  prepare(): Promise<number> {
    return this.settings.get("review_check_max_wait_minutes");
  }

  async claim(
    tx: DbExecutor,
    minutes: number,
    batch: { limit: number; excludeIds: string[] },
  ): Promise<string[]> {
    const rows = await tx
      .select({ id: review.id })
      .from(review)
      .where(
        and(
          eq(review.status, "checking"),
          sql`${review.checkingSince} < now() - make_interval(mins => ${minutes})`,
          batch.excludeIds.length > 0 ? notInArray(review.id, batch.excludeIds) : undefined,
        ),
      )
      .orderBy(asc(review.checkingSince))
      .limit(batch.limit)
      .for("update", { skipLocked: true });
    return rows.map((row) => row.id);
  }

  async apply(tx: DbExecutor, minutes: number, reviewId: string): Promise<void> {
    const [updated] = await tx
      .update(review)
      .set({
        status: "held",
        holdReasons: [checkUnavailableReason(`ждал проверки дольше ${String(minutes)} мин`)],
        checkingSince: null,
        version: sql`${review.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(review.id, reviewId),
          eq(review.status, "checking"),
          sql`${review.checkingSince} < now() - make_interval(mins => ${minutes})`,
        ),
      )
      .returning();
    if (!updated) {
      return;
    }
    await this.audit.record(
      {
        action: auditActions.reviewChecked,
        actor: { role: "system" },
        entityType: auditEntities.review,
        entityId: reviewId,
        before: { status: "checking" },
        after: {
          status: "held",
          reasons: ["system:check_unavailable"],
          orderId: updated.orderId,
          supplierId: updated.supplierId,
          accountId: updated.userAccountId,
        },
      },
      tx,
    );
  }

  summary(result: SweepResult): void {
    if (result.processed > 0) {
      this.logger.log(
        `Reviews held after waiting too long for the check reviews=${String(result.processed)}`,
      );
    }
  }
}
