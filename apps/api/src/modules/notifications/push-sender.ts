import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, asc, eq, isNull, lt, notInArray } from "drizzle-orm";
import { DatabaseService, type DbExecutor } from "../../database";
import {
  PermanentJobError,
  type JobHandler,
  type JobRunContext,
  type Sweeper,
  type SweepResult,
} from "../../jobs";
import { sanitizeForLog } from "../../observability";
import { session } from "../identity";
import { AppSettings } from "../settings";
import { liveSession, rollupNotification } from "./notifications.service";
import {
  PushDeliveryError,
  PushProvider,
  type PushFailureKind,
  type PushSendRequest,
} from "./push-provider";
import { PushRenderError, renderPushText, type PushTemplateCode } from "./push-templates";
import {
  deviceToken,
  notification,
  notificationDelivery,
  type NotificationDeliveryRow,
} from "./schema";

/**
 * The worker's side of a push to one device (TASK-051 requirement 3) — the
 * shape of `MessageSender` (ARCHITECTURE 4.35):
 *
 * 1. **claim** — one short transaction: lock the delivery, check that its
 *    token is still on push (its session holds, it still belongs to the
 *    recipient), render the text, mark it `sending` with a claim;
 * 2. **send** — the provider is called with no transaction open and no row
 *    locked;
 * 3. **record** — the provider's id is written down in a write of its own;
 * 4. **settle** — `sent` or the failure, and the notification's status from
 *    its deliveries.
 *
 * Only a failure of `send` itself, and only one the provider certainly did
 * not take (`unavailable`), puts a delivery back on the queue. `unknown` is
 * never retried by itself; an interrupted attempt is recovered by its claim
 * running out — `sent` if the id was recorded, `unknown` if not.
 */

type ClaimResult =
  | { kind: "send"; row: NotificationDeliveryRow; request: PushSendRequest }
  | { kind: "done"; reason: string }
  | { kind: "held"; until: Date }
  | { kind: "render_failed"; reason: string };

const RECORD_PAUSES_MS = [250, 1_000];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

@Injectable()
export class PushSender implements JobHandler<{ deliveryId: string }> {
  private readonly logger = new Logger("Notifications");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(PushProvider) private readonly provider: PushProvider,
    @Inject(AppSettings) private readonly settings: AppSettings,
  ) {}

  async run({ deliveryId }: { deliveryId: string }, context: JobRunContext): Promise<void> {
    const claimed = await this.claim(deliveryId);
    if (claimed.kind === "done") {
      return;
    }
    if (claimed.kind === "held") {
      throw new PushDeliveryError(
        "unavailable",
        `The delivery is held by another attempt until ${claimed.until.toISOString()}`,
      );
    }
    if (claimed.kind === "render_failed") {
      await this.settle(deliveryId, {
        status: "failed",
        failure: "render_failed",
        reason: claimed.reason,
      });
      throw new PermanentJobError(`The push ${deliveryId} cannot be rendered: ${claimed.reason}`);
    }
    const { row, request } = claimed;
    let providerMessageId: string;
    try {
      providerMessageId = (await this.provider.send(request, context.signal)).providerMessageId;
    } catch (error) {
      return this.afterFailedSend(row, error, context);
    }
    await this.recordSent(row, providerMessageId);
    this.logger.log(
      `Push sent delivery=${row.id} notification=${row.notificationId} platform=${row.platform} token=${row.tokenMask} provider=${this.provider.providerFor(row.platform)}`,
    );
  }

  private async afterFailedSend(
    row: NotificationDeliveryRow,
    error: unknown,
    context: JobRunContext,
  ): Promise<void> {
    const failure =
      error instanceof PushDeliveryError
        ? error
        : new PushDeliveryError(
            "unknown",
            `The provider failed unexpectedly (${error instanceof Error ? error.name : "unknown"})`,
          );
    const reason = sanitizeForLog(failure.message).slice(0, 500);
    const attempt = row.attempts + 1;
    if (failure.kind === "invalid_token") {
      // The device is gone (the app was removed): off push for good; the
      // person's other devices are not touched. An ordinary outcome, not a
      // failed job.
      await this.settle(row.id, {
        status: "failed",
        failure: "invalid_token",
        reason,
        deadToken: true,
      });
      this.logger.warn(
        `Push token dead, taken off push delivery=${row.id} token=${row.tokenMask}: ${reason}`,
      );
      return;
    }
    if (failure.kind === "unknown") {
      await this.settle(row.id, { status: "unknown", reason: `outcome unknown: ${reason}` });
      this.logger.warn(`Push left in an unknown state delivery=${row.id}: ${reason}`);
      throw new PermanentJobError(`The push ${row.id} may have been sent: ${reason}`);
    }
    if (failure.kind === "unavailable") {
      if (attempt < row.maxAttempts) {
        await this.release(row.id, reason);
        this.logger.warn(
          `Push not sent, will retry delivery=${row.id} attempt=${String(attempt)}/${String(row.maxAttempts)} job=${String(context.attempt)}: ${reason}`,
        );
        throw failure;
      }
      await this.settle(row.id, {
        status: "failed",
        failure: "unavailable",
        reason: `attempts exhausted (${String(attempt)}): ${reason}`,
      });
      this.logger.warn(`Push not sent, attempts exhausted delivery=${row.id}: ${reason}`);
      throw new PermanentJobError(`The push ${row.id} was not sent in ${String(attempt)} attempts`);
    }
    await this.settle(row.id, { status: "failed", failure: failure.kind, reason });
    this.logger.warn(`Push refused for good delivery=${row.id} kind=${failure.kind}: ${reason}`);
    throw new PermanentJobError(`The push ${row.id} was refused: ${failure.kind}`);
  }

  private async recordSent(row: NotificationDeliveryRow, providerMessageId: string): Promise<void> {
    try {
      await this.tried(async () => {
        await this.database.db
          .update(notificationDelivery)
          .set({
            providerMessageId,
            provider: this.provider.providerFor(row.platform),
            updatedAt: new Date(),
          })
          .where(
            and(eq(notificationDelivery.id, row.id), eq(notificationDelivery.status, "sending")),
          );
      });
      await this.tried(() => this.settle(row.id, { status: "sent", providerMessageId }));
    } catch (error) {
      this.logger.error(
        `Push sent but not recorded delivery=${row.id}: ${sanitizeForLog(error instanceof Error ? error.name : "error")}`,
      );
      throw error;
    }
  }

  private async tried(write: () => Promise<void>): Promise<void> {
    let last: unknown;
    for (let attempt = 0; attempt <= RECORD_PAUSES_MS.length; attempt++) {
      try {
        await write();
        return;
      } catch (error) {
        last = error;
        const pause = RECORD_PAUSES_MS[attempt];
        if (pause === undefined) break;
        await sleep(pause);
      }
    }
    throw last;
  }

  /** Step 1: what to send, or why nothing is. Every lock is gone when it returns. */
  private async claim(deliveryId: string): Promise<ClaimResult> {
    const { push_send_claim_seconds: claimSeconds, push_send_attempts: attemptsSetting } =
      await this.settings.values();
    return this.database.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(notificationDelivery)
        .where(eq(notificationDelivery.id, deliveryId))
        .for("update");
      if (!row) {
        return { kind: "done", reason: "no such delivery" };
      }
      if (row.status === "sending") {
        const until = row.claimedUntil;
        if (until && until.getTime() > Date.now()) {
          return { kind: "held", until };
        }
        const outcome = await recoverInterruptedDelivery(tx, row, this.logger);
        return { kind: "done", reason: `recovered as ${outcome}` };
      }
      // `queued` is the ordinary case; `failed` — the operator's `jobs:retry` of
      // a dead job (the provider never took it). Everything else is not sent.
      if (row.status !== "queued" && row.status !== "failed") {
        return { kind: "done", reason: `already ${row.status}` };
      }
      const [parent] = await tx
        .select()
        .from(notification)
        .where(eq(notification.id, row.notificationId));
      // The device is still the recipient's and still on push: its session
      // holds. A session that ended after the push was queued gets nothing.
      const [token] = row.deviceTokenId
        ? await tx
            .select({ token: deviceToken.token, accountId: deviceToken.accountId })
            .from(deviceToken)
            .innerJoin(session, eq(session.id, deviceToken.sessionId))
            .where(
              and(
                eq(deviceToken.id, row.deviceTokenId),
                isNull(deviceToken.deactivatedAt),
                liveSession(),
              ),
            )
        : [];
      if (!parent || !token || token.accountId !== parent.recipientAccountId) {
        const now = new Date();
        await tx
          .update(notificationDelivery)
          .set({ status: "cancelled", settledAt: now, claimedUntil: null, updatedAt: now })
          .where(eq(notificationDelivery.id, row.id));
        await rollupNotification(tx, row.notificationId);
        this.logger.log(
          `Push cancelled delivery=${row.id} token=${row.tokenMask}: the device is no longer on push`,
        );
        return { kind: "done", reason: "cancelled" };
      }
      let body: string;
      try {
        body = renderPushText(
          parent.templateCode as PushTemplateCode,
          parent.lang,
          parent.payload.variables,
        );
      } catch (error) {
        return {
          kind: "render_failed",
          reason: error instanceof PushRenderError ? error.reason : "unexpected",
        };
      }
      const maxAttempts =
        row.status === "failed" ? row.attempts + attemptsSetting : row.maxAttempts;
      await tx
        .update(notificationDelivery)
        .set({
          status: "sending",
          attempts: row.attempts + 1,
          maxAttempts,
          settledAt: null,
          failureKind: null,
          claimedUntil: new Date(Date.now() + claimSeconds * 1000),
          updatedAt: new Date(),
        })
        .where(eq(notificationDelivery.id, row.id));
      return {
        kind: "send",
        // The attempt is counted in the row; `afterFailedSend` counts this one itself.
        row: { ...row, maxAttempts },
        request: {
          token: token.token,
          platform: row.platform,
          body,
          data: { notificationId: parent.id, target: parent.payload.target },
          collapseKey: parent.id,
        },
      };
    });
  }

  private async settle(
    deliveryId: string,
    outcome:
      | { status: "sent"; providerMessageId: string }
      | {
          status: "failed";
          failure: PushFailureKind | "render_failed";
          reason: string;
          deadToken?: boolean;
        }
      | { status: "unknown"; reason: string },
  ): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(notificationDelivery)
        .where(eq(notificationDelivery.id, deliveryId))
        .for("update");
      if (!row) return;
      const now = new Date();
      if (outcome.status === "sent") {
        await tx
          .update(notificationDelivery)
          .set({
            status: "sent",
            provider: this.provider.providerFor(row.platform),
            providerMessageId: outcome.providerMessageId,
            sentAt: now,
            settledAt: now,
            claimedUntil: null,
            failureKind: null,
            lastError: null,
            updatedAt: now,
          })
          .where(eq(notificationDelivery.id, row.id));
      } else {
        await tx
          .update(notificationDelivery)
          .set({
            status: outcome.status,
            provider: this.provider.providerFor(row.platform),
            failureKind: outcome.status === "failed" ? outcome.failure : null,
            lastError: outcome.reason.slice(0, 500),
            settledAt: now,
            claimedUntil: null,
            updatedAt: now,
          })
          .where(eq(notificationDelivery.id, row.id));
        if (outcome.status === "failed" && outcome.deadToken && row.deviceTokenId) {
          await tx
            .update(deviceToken)
            .set({ deactivatedAt: now, deactivatedReason: "invalid_token", updatedAt: now })
            .where(and(eq(deviceToken.id, row.deviceTokenId), isNull(deviceToken.deactivatedAt)));
        }
      }
      await rollupNotification(tx, row.notificationId);
    });
  }

  /** `unavailable`, attempts left: back to `queued`. */
  private async release(deliveryId: string, reason: string): Promise<void> {
    await this.database.db
      .update(notificationDelivery)
      .set({
        status: "queued",
        claimedUntil: null,
        lastError: `unavailable: ${reason}`.slice(0, 500),
        updatedAt: new Date(),
      })
      .where(
        and(eq(notificationDelivery.id, deliveryId), eq(notificationDelivery.status, "sending")),
      );
  }
}

/** An attempt that never settled and whose claim ran out. Never sends anything. */
export async function recoverInterruptedDelivery(
  tx: DbExecutor,
  row: NotificationDeliveryRow,
  logger: Logger,
): Promise<"sent" | "unknown"> {
  const now = new Date();
  if (row.providerMessageId) {
    await tx
      .update(notificationDelivery)
      .set({
        status: "sent",
        sentAt: row.sentAt ?? now,
        settledAt: now,
        claimedUntil: null,
        updatedAt: now,
      })
      .where(eq(notificationDelivery.id, row.id));
    await rollupNotification(tx, row.notificationId);
    logger.warn(`Push recovered as sent delivery=${row.id}`);
    return "sent";
  }
  await tx
    .update(notificationDelivery)
    .set({
      status: "unknown",
      settledAt: now,
      claimedUntil: null,
      lastError: "interrupted while sending",
      updatedAt: now,
    })
    .where(eq(notificationDelivery.id, row.id));
  await rollupNotification(tx, row.notificationId);
  logger.warn(`Push left in an unknown state delivery=${row.id}: an attempt was interrupted`);
  return "unknown";
}

/** How long past its claim a `sending` delivery is left alone by the sweeper. */
export const PUSH_RECOVERY_GRACE_MS = 60_000;

export class InterruptedPushSweep implements Sweeper<Date> {
  private readonly logger = new Logger("Notifications");

  prepare(): Promise<Date> {
    return Promise.resolve(new Date(Date.now() - PUSH_RECOVERY_GRACE_MS));
  }

  async claim(
    tx: DbExecutor,
    cutoff: Date,
    batch: { limit: number; excludeIds: string[] },
  ): Promise<string[]> {
    const rows = await tx
      .select({ id: notificationDelivery.id })
      .from(notificationDelivery)
      .where(
        and(
          eq(notificationDelivery.status, "sending"),
          lt(notificationDelivery.claimedUntil, cutoff),
          batch.excludeIds.length > 0
            ? notInArray(notificationDelivery.id, batch.excludeIds)
            : undefined,
        ),
      )
      .orderBy(asc(notificationDelivery.claimedUntil))
      .limit(batch.limit)
      .for("update", { skipLocked: true });
    return rows.map((row) => row.id);
  }

  async apply(tx: DbExecutor, cutoff: Date, id: string): Promise<void> {
    const [row] = await tx
      .select()
      .from(notificationDelivery)
      .where(eq(notificationDelivery.id, id))
      .for("update");
    if (
      !row ||
      row.status !== "sending" ||
      !row.claimedUntil ||
      row.claimedUntil.getTime() >= cutoff.getTime()
    ) {
      return;
    }
    await recoverInterruptedDelivery(tx, row, this.logger);
  }

  summary(result: SweepResult): void {
    if (result.processed > 0) {
      this.logger.log(`Interrupted pushes recovered rows=${String(result.processed)}`);
    }
  }
}
