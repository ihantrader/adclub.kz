import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { auditActions, auditEntities } from "@adclub/contracts";
import { maskPhone, normalizeKzMobilePhone } from "@adclub/domain";
import { and, desc, eq, gt, isNull, sql, type SQL } from "drizzle-orm";
import { APP_CONFIG, type AppConfig } from "../../../config";
import { DatabaseService, type DbExecutor } from "../../../database";
import { ActionJournal } from "../action-journal";
import { OperatorCommandError } from "../admin/operator.service";
import { otpChallenge, reviewLogin } from "../schema";
import { hashLoginCode } from "./login-code.crypto";

/** The code reviewers type: always six digits, whatever `login_code_length` says. */
export const REVIEW_LOGIN_CODE_LENGTH = 6;

/**
 * Who a constant code is for:
 * - `store_review` — App Store and Google Play reviewers (TASK-077): the app
 *   only, one number at a time, in every environment;
 * - `tester` — the people who try staging (TASK-055): the app, the cabinet
 *   and the admin panel (an administrator still needs the second factor),
 *   never in production, at most `MAX_ENABLED_TESTERS` numbers for at most
 *   `TESTER_MAX_TERM_DAYS` days each.
 */
export type ReviewLoginScope = "store_review" | "tester";
export const MAX_ENABLED_TESTERS = 10;
export const TESTER_MAX_TERM_DAYS = 31;

/** The enabled sign-in for store review, if it is still in term. */
export interface ActiveReviewLogin {
  id: string;
  phone: string;
  codeHash: string;
  validUntil: Date;
  scope: ReviewLoginScope;
}

export interface ReviewLoginStatus {
  state: "enabled" | "expired" | "disabled" | "none";
  current: {
    id: string;
    phoneMasked: string;
    validUntil: string;
    enabledAt: string;
    reason: string;
    disabledAt: string | null;
    disabledReason: string | null;
  } | null;
  /** Testers' numbers enabled now (TASK-055), masked. */
  testers: { id: string; phoneMasked: string; validUntil: string; enabledAt: string }[];
  history: {
    id: string;
    scope: ReviewLoginScope;
    phoneMasked: string;
    validUntil: string;
    enabledAt: string;
    disabledAt: string | null;
    disabledReason: string | null;
  }[];
}

const LOCK = "review-login";
const DAY_MS = 86_400_000;

/**
 * The sign-in with a constant code (TASK-077; PRODUCT 5; ARCHITECTURE 4.73,
 * 4.82): a number and a code that App Store and Google Play reviewers are
 * given, because no WhatsApp or SMS reaches them — and, outside production,
 * testers' numbers for an environment whose channels reach nobody (staging).
 * Only the operator command enables, disables and shows it — it is sign-in
 * security (D-053); the API has no route for it. The code is stored as an
 * HMAC bound to the row (as a login code is bound to its challenge), the
 * term is required, and nothing is enabled by default.
 *
 * What it opens is decided by `opens` (used by `LoginCodeService`): only
 * while enabled and in term, with the ordinary limits and the ordinary
 * counting of wrong codes. The account behind it is an ordinary one.
 */
@Injectable()
export class ReviewLogins {
  private readonly logger = new Logger("ReviewLogin");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ActionJournal) private readonly audit: ActionJournal,
  ) {}

  /**
   * Whether a constant code of this scope signs in the session being opened:
   * the store review one — the mobile app only; a tester's — any client,
   * outside production.
   */
  opens(scope: ReviewLoginScope, mobileSession: boolean): boolean {
    return scope === "store_review" ? mobileSession : this.config.nodeEnv !== "production";
  }

  /** The enabled, in-term sign-in for this number, if any. */
  async activeFor(phone: string, now: Date): Promise<ActiveReviewLogin | undefined> {
    const [row] = await this.database.db
      .select({
        id: reviewLogin.id,
        phone: reviewLogin.phone,
        codeHash: reviewLogin.codeHash,
        validUntil: reviewLogin.validUntil,
        scope: reviewLogin.scope,
      })
      .from(reviewLogin)
      .where(
        and(
          eq(reviewLogin.phone, phone),
          isNull(reviewLogin.disabledAt),
          gt(reviewLogin.validUntil, now),
        ),
      );
    return row;
  }

  async enable(input: {
    phone: string;
    code: string;
    validUntil: Date;
    reason: string;
    /** A tester's number (TASK-055) rather than the store review one. */
    tester?: boolean;
  }): Promise<{
    id: string;
    scope: ReviewLoginScope;
    phoneMasked: string;
    validUntil: string;
    replaced: string | null;
  }> {
    const scope: ReviewLoginScope = input.tester ? "tester" : "store_review";
    const phone = normalizeKzMobilePhone(input.phone);
    if (!phone) {
      throw new OperatorCommandError("Not a Kazakhstan mobile number (+7 7xx xxx xx xx)");
    }
    if (!new RegExp(`^\\d{${REVIEW_LOGIN_CODE_LENGTH}}$`).test(input.code)) {
      throw new OperatorCommandError(`--code must be ${REVIEW_LOGIN_CODE_LENGTH} digits`);
    }
    const now = new Date();
    if (input.validUntil.getTime() <= now.getTime()) {
      throw new OperatorCommandError("--until must be in the future");
    }
    if (scope === "tester") {
      if (this.config.nodeEnv === "production") {
        throw new OperatorCommandError(
          "Testers' numbers are for staging and development; production has real channels",
        );
      }
      if (input.validUntil.getTime() > now.getTime() + TESTER_MAX_TERM_DAYS * DAY_MS) {
        throw new OperatorCommandError(
          `--until: a tester's number is enabled for at most ${TESTER_MAX_TERM_DAYS} days`,
        );
      }
    }
    const reason = input.reason.trim();
    if (!reason) {
      throw new OperatorCommandError("--reason must not be empty");
    }
    const id = randomUUID();
    const masked = maskPhone(phone);
    const replaced = await this.database.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${LOCK}, 0))`);
      // The number's own enabled row, whatever its scope, is replaced; the
      // store review number is one at a time.
      const samePhone = await this.endCurrent(tx, now, "replaced", eq(reviewLogin.phone, phone));
      const storeReview =
        scope === "store_review"
          ? await this.endCurrent(tx, now, "replaced", eq(reviewLogin.scope, "store_review"))
          : undefined;
      const previous = storeReview ?? samePhone;
      if (scope === "tester") {
        const [{ enabled }] = (
          await tx.execute<{ enabled: number }>(
            sql`SELECT count(*)::int AS enabled FROM review_login
                WHERE scope = 'tester' AND disabled_at IS NULL AND valid_until > ${now}`,
          )
        ).rows as [{ enabled: number }];
        if (enabled >= MAX_ENABLED_TESTERS) {
          throw new OperatorCommandError(
            `At most ${MAX_ENABLED_TESTERS} testers' numbers are enabled at a time; disable one first (review-login:disable --phone <phone>)`,
          );
        }
      }
      await tx.insert(reviewLogin).values({
        id,
        phone,
        codeHash: hashLoginCode(this.config.loginCode.hashSecret, id, input.code),
        validUntil: input.validUntil,
        reason,
        scope,
        enabledAt: now,
      });
      await this.audit.record(
        {
          action: auditActions.reviewLoginEnabled,
          actor: { role: "operator" },
          entityType: auditEntities.reviewLogin,
          entityId: id,
          ...(previous && {
            before: {
              replacedId: previous.id,
              phoneMasked: maskPhone(previous.phone),
              validUntil: previous.validUntil.toISOString(),
            },
          }),
          after: { phoneMasked: masked, validUntil: input.validUntil.toISOString(), scope },
          reason,
        },
        tx,
      );
      return previous;
    });
    this.logger.log(
      `Constant-code sign-in enabled id=${id} scope=${scope} phone=${masked} until=${input.validUntil.toISOString()}${replaced ? ` replaced=${replaced.id}` : ""}`,
    );
    return {
      id,
      scope,
      phoneMasked: masked,
      validUntil: input.validUntil.toISOString(),
      replaced: replaced?.id ?? null,
    };
  }

  /**
   * Ends the store review sign-in, or — with a number — that number's
   * sign-in of either scope (a tester's).
   */
  async disable(
    reasonInput: string | undefined,
    phoneInput?: string,
  ): Promise<{ disabled: string | null }> {
    const reason = reasonInput?.trim() || "disabled by the operator";
    let which: SQL = eq(reviewLogin.scope, "store_review");
    if (phoneInput !== undefined) {
      const phone = normalizeKzMobilePhone(phoneInput);
      if (!phone) {
        throw new OperatorCommandError("Not a Kazakhstan mobile number (+7 7xx xxx xx xx)");
      }
      which = eq(reviewLogin.phone, phone);
    }
    const now = new Date();
    const ended = await this.database.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${LOCK}, 0))`);
      const current = await this.endCurrent(tx, now, reason, which);
      if (current) {
        await this.audit.record(
          {
            action: auditActions.reviewLoginDisabled,
            actor: { role: "operator" },
            entityType: auditEntities.reviewLogin,
            entityId: current.id,
            before: {
              phoneMasked: maskPhone(current.phone),
              validUntil: current.validUntil.toISOString(),
            },
            reason,
          },
          tx,
        );
      }
      return current;
    });
    if (ended) {
      this.logger.log(
        `Constant-code sign-in disabled id=${ended.id} phone=${maskPhone(ended.phone)}`,
      );
    }
    return { disabled: ended?.id ?? null };
  }

  async status(): Promise<ReviewLoginStatus> {
    const rows = await this.database.db
      .select()
      .from(reviewLogin)
      .orderBy(desc(reviewLogin.enabledAt))
      .limit(30);
    const now = Date.now();
    const storeReview = rows.filter((row) => row.scope === "store_review");
    const current = storeReview.find((row) => row.disabledAt === null) ?? storeReview[0];
    const state: ReviewLoginStatus["state"] = !current
      ? "none"
      : current.disabledAt !== null
        ? "disabled"
        : current.validUntil.getTime() <= now
          ? "expired"
          : "enabled";
    return {
      state,
      current: current
        ? {
            id: current.id,
            phoneMasked: maskPhone(current.phone),
            validUntil: current.validUntil.toISOString(),
            enabledAt: current.enabledAt.toISOString(),
            reason: current.reason,
            disabledAt: current.disabledAt?.toISOString() ?? null,
            disabledReason: current.disabledReason,
          }
        : null,
      testers: rows
        .filter(
          (row) =>
            row.scope === "tester" && row.disabledAt === null && row.validUntil.getTime() > now,
        )
        .map((row) => ({
          id: row.id,
          phoneMasked: maskPhone(row.phone),
          validUntil: row.validUntil.toISOString(),
          enabledAt: row.enabledAt.toISOString(),
        })),
      history: rows.slice(0, 10).map((row) => ({
        id: row.id,
        scope: row.scope,
        phoneMasked: maskPhone(row.phone),
        validUntil: row.validUntil.toISOString(),
        enabledAt: row.enabledAt.toISOString(),
        disabledAt: row.disabledAt?.toISOString() ?? null,
        disabledReason: row.disabledReason,
      })),
    };
  }

  /**
   * Ends the enabled row matching `which`, if any, and the codes it had
   * opened: a challenge of an ended sign-in never accepts the code again.
   */
  private async endCurrent(
    tx: DbExecutor,
    now: Date,
    reason: string,
    which: SQL,
  ): Promise<{ id: string; phone: string; validUntil: Date } | undefined> {
    const [current] = await tx
      .update(reviewLogin)
      .set({ disabledAt: now, disabledReason: reason, updatedAt: now })
      .where(and(isNull(reviewLogin.disabledAt), which))
      .returning({
        id: reviewLogin.id,
        phone: reviewLogin.phone,
        validUntil: reviewLogin.validUntil,
      });
    if (current) {
      await tx
        .update(otpChallenge)
        .set({ status: "expired", updatedAt: now })
        .where(
          and(
            eq(otpChallenge.reviewLoginId, current.id),
            sql`${otpChallenge.status} IN ('pending', 'active')`,
          ),
        );
    }
    return current;
  }
}
