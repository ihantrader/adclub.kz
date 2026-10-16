import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { auditActions, auditEntities } from "@adclub/contracts";
import { maskPhone, normalizeKzMobilePhone } from "@adclub/domain";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { APP_CONFIG, type AppConfig } from "../../../config";
import { DatabaseService, type DbExecutor } from "../../../database";
import { ActionJournal } from "../action-journal";
import { OperatorCommandError } from "../admin/operator.service";
import { otpChallenge, reviewLogin } from "../schema";
import { hashLoginCode } from "./login-code.crypto";

/** The code reviewers type: always six digits, whatever `login_code_length` says. */
export const REVIEW_LOGIN_CODE_LENGTH = 6;

/** The enabled sign-in for store review, if it is still in term. */
export interface ActiveReviewLogin {
  id: string;
  phone: string;
  codeHash: string;
  validUntil: Date;
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
  history: {
    id: string;
    phoneMasked: string;
    validUntil: string;
    enabledAt: string;
    disabledAt: string | null;
    disabledReason: string | null;
  }[];
}

const LOCK = "review-login";

/**
 * The sign-in for store review (TASK-077; PRODUCT 5; ARCHITECTURE 4.73):
 * a number and a constant code that App Store and Google Play reviewers
 * are given, because no WhatsApp or SMS reaches them. Only the operator
 * command enables, disables and shows it — it is sign-in security (D-053);
 * the API has no route for it. The code is stored as an HMAC bound to the
 * row (as a login code is bound to its challenge), the term is required,
 * and nothing is enabled by default.
 *
 * What it opens is decided by `LoginCodeService`: only the mobile app, only
 * while enabled and in term, with the ordinary limits and the ordinary
 * counting of wrong codes. The account behind it is an ordinary user.
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

  /** The enabled, in-term sign-in for this number, if any. */
  async activeFor(phone: string, now: Date): Promise<ActiveReviewLogin | undefined> {
    const [row] = await this.database.db
      .select({
        id: reviewLogin.id,
        phone: reviewLogin.phone,
        codeHash: reviewLogin.codeHash,
        validUntil: reviewLogin.validUntil,
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
  }): Promise<{ id: string; phoneMasked: string; validUntil: string; replaced: string | null }> {
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
    const reason = input.reason.trim();
    if (!reason) {
      throw new OperatorCommandError("--reason must not be empty");
    }
    const id = randomUUID();
    const masked = maskPhone(phone);
    const replaced = await this.database.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${LOCK}, 0))`);
      const previous = await this.endCurrent(tx, now, "replaced");
      await tx.insert(reviewLogin).values({
        id,
        phone,
        codeHash: hashLoginCode(this.config.loginCode.hashSecret, id, input.code),
        validUntil: input.validUntil,
        reason,
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
          after: { phoneMasked: masked, validUntil: input.validUntil.toISOString() },
          reason,
        },
        tx,
      );
      return previous;
    });
    this.logger.log(
      `Store review sign-in enabled id=${id} phone=${masked} until=${input.validUntil.toISOString()}${replaced ? ` replaced=${replaced.id}` : ""}`,
    );
    return {
      id,
      phoneMasked: masked,
      validUntil: input.validUntil.toISOString(),
      replaced: replaced?.id ?? null,
    };
  }

  async disable(reasonInput: string | undefined): Promise<{ disabled: string | null }> {
    const reason = reasonInput?.trim() || "disabled by the operator";
    const now = new Date();
    const ended = await this.database.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${LOCK}, 0))`);
      const current = await this.endCurrent(tx, now, reason);
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
        `Store review sign-in disabled id=${ended.id} phone=${maskPhone(ended.phone)}`,
      );
    }
    return { disabled: ended?.id ?? null };
  }

  async status(): Promise<ReviewLoginStatus> {
    const rows = await this.database.db
      .select()
      .from(reviewLogin)
      .orderBy(desc(reviewLogin.enabledAt))
      .limit(10);
    const now = Date.now();
    const current = rows.find((row) => row.disabledAt === null) ?? rows[0];
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
      history: rows.map((row) => ({
        id: row.id,
        phoneMasked: maskPhone(row.phone),
        validUntil: row.validUntil.toISOString(),
        enabledAt: row.enabledAt.toISOString(),
        disabledAt: row.disabledAt?.toISOString() ?? null,
        disabledReason: row.disabledReason,
      })),
    };
  }

  /**
   * Ends the enabled row, if any, and the codes it had opened: a challenge
   * of an ended sign-in never accepts the code again.
   */
  private async endCurrent(
    tx: DbExecutor,
    now: Date,
    reason: string,
  ): Promise<{ id: string; phone: string; validUntil: Date } | undefined> {
    const [current] = await tx
      .update(reviewLogin)
      .set({ disabledAt: now, disabledReason: reason, updatedAt: now })
      .where(isNull(reviewLogin.disabledAt))
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
