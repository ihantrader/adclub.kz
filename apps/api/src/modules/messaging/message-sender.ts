import { Inject, Injectable, Logger } from "@nestjs/common";
import { maskPhone } from "@adclub/domain";
import { and, eq } from "drizzle-orm";
import { DatabaseService, type DbExecutor } from "../../database";
import { PermanentJobError, type JobHandler, type JobRunContext } from "../../jobs";
import { sanitizeForLog } from "../../observability";
import { AppSettings } from "../settings";
import {
  MessageChannel,
  MessageDeliveryError,
  isTemporaryFailure,
  type MessageFailureKind,
  type MessageSendRequest,
} from "./message-channel";
import { recoverInterruptedMessage } from "./message-recovery";
import { MessageSubjects, type MessageOutcome } from "./message-subjects";
import {
  MessageRenderError,
  messageTemplate,
  orderedVariables,
  renderMessageText,
} from "./message-templates";
import { outboundMessage, type OutboundMessageRow } from "./schema";

/**
 * The worker's side of sending (TASK-024 requirement 3). Four steps, and
 * the shape of them is the point:
 *
 * 1. **claim** — one short transaction: read the message, ask the module
 *    that owns its subject whether it may still go (an invitation whose
 *    employee has been removed may not), and mark it `sending` with a
 *    claim. Locks are taken here and released when it commits.
 * 2. **send** — the provider is called with no transaction open and no row
 *    locked. This is what TASK-017 asked for: removing an employee no
 *    longer waits for the provider's answer.
 * 3. **record** — the moment the provider has answered with an id, that id is
 *    written down in a short write of its own. From here on the message is
 *    known to be out: nothing below may put it back on the queue.
 * 4. **settle** — one short transaction: `sent`, or the failure; the values
 *    of the placeholders are cleared, and the owning module keeps whatever
 *    it keeps.
 *
 * What keeps "one event, one message" true, and what it costs:
 *
 * - Only the transaction that turned `queued` into `sending` goes on to send,
 *   so two workers never send one message twice. A live claim means another
 *   attempt holds the message: this run comes back later.
 * - **Only a failure of `send` itself can put a message back on the queue**,
 *   and only when the provider certainly did not take it (it refused, was
 *   unreachable, or limited us). A failure of steps 3 and 4 after the
 *   provider answered is retried in place and, if it persists, leaves the
 *   message `sending`: when the claim runs out the message is `sent` if its
 *   id was recorded, `unknown` if not. Never a second copy.
 * - **An outcome nobody can be sure of is `unknown`, not a retry** — a
 *   timeout after the request was sent, a connection that dropped, a 200
 *   without an id, a claim that ran out while sending. The Cloud API has no
 *   idempotency key for a send, so a second attempt could reach a real
 *   person twice; a person decides (`messages:retry`).
 */

type ClaimResult =
  | { kind: "send"; row: OutboundMessageRow; request: MessageSendRequest; maxAttempts: number }
  | { kind: "done"; reason: string }
  | { kind: "held"; until: Date }
  | { kind: "render_failed"; row: OutboundMessageRow; reason: string };

/** Pauses between the tries of a write that must not be lost once the provider has the message. */
const RECORD_PAUSES_MS = [250, 1_000];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

@Injectable()
export class MessageSender implements JobHandler<{ messageId: string }> {
  private readonly logger = new Logger("Messaging");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(MessageChannel) private readonly channel: MessageChannel,
    @Inject(MessageSubjects) private readonly subjects: MessageSubjects,
    @Inject(AppSettings) private readonly settings: AppSettings,
  ) {}

  async run({ messageId }: { messageId: string }, context: JobRunContext): Promise<void> {
    const claimed = await this.claim(messageId);
    if (claimed.kind === "done") {
      return;
    }
    if (claimed.kind === "held") {
      // Another attempt is sending it right now: come back later rather
      // than send a second copy.
      throw new MessageDeliveryError(
        "unavailable",
        `The message is held by another attempt until ${claimed.until.toISOString()}`,
      );
    }
    if (claimed.kind === "render_failed") {
      await this.settle(messageId, {
        kind: "failed",
        failure: "render_failed",
        reason: claimed.reason,
      });
      // No retry can render it: straight to the dead letter queue, where
      // the operator sees it.
      throw new PermanentJobError(`The message ${messageId} cannot be rendered: ${claimed.reason}`);
    }

    const { row, request, maxAttempts } = claimed;
    let providerMessageId: string;
    try {
      providerMessageId = (await this.channel.send(request, context.signal)).providerMessageId;
    } catch (error) {
      // Always throws: either the queue retries, or the job is over.
      return this.afterFailedSend(row, maxAttempts, error, context);
    }

    // The provider has the message. From here nothing puts it back on the
    // queue, whatever goes wrong with our own bookkeeping.
    await this.recordSent(row, providerMessageId);
    this.logger.log(
      `Message sent message=${row.id} template=${row.template} lang=${row.lang} channel=${this.channel.provider} phone=${maskPhone(row.phone)}`,
    );
  }

  /** What a failed `send` means for the message. Never returns. */
  private async afterFailedSend(
    row: OutboundMessageRow,
    maxAttempts: number,
    error: unknown,
    context: JobRunContext,
  ): Promise<never> {
    const failure =
      error instanceof MessageDeliveryError
        ? error
        : // An error of the channel that is not one of ours can say anything —
          // a name, a number — and the sanitizer cannot know a name: only the
          // kind of error is kept, never its message or its cause. A failure we
          // cannot read is one whose outcome we cannot know.
          new MessageDeliveryError(
            "outcome_unknown",
            `The channel failed unexpectedly (${error instanceof Error ? error.name : "unknown"})`,
          );
    const reason = sanitizeForLog(failure.message).slice(0, 500);
    const attempt = row.attempts + 1;

    if (failure.kind === "outcome_unknown") {
      // The provider may have the message: nothing is sent again by itself.
      await this.settle(row.id, { kind: "unknown", reason: `outcome unknown: ${reason}` });
      this.logger.warn(
        `Message left in an unknown state message=${row.id} template=${row.template}: ${reason}`,
      );
      throw new PermanentJobError(`The message ${row.id} may have been sent: ${reason}`);
    }

    if (isTemporaryFailure(failure.kind)) {
      if (attempt < maxAttempts) {
        // Back to the queue: the attempt is counted, the values stay, and the
        // queue decides when to try again (the pause grows).
        await this.release(row.id, failure.kind, reason);
        this.logger.warn(
          `Message not sent, will retry message=${row.id} template=${row.template} kind=${failure.kind} attempt=${String(attempt)}/${String(maxAttempts)} job=${String(context.attempt)}: ${reason}`,
        );
        throw failure;
      }
      // The last attempt the setting allows: the message is `failed`, not
      // waiting — so its values fall under the retention like any refused
      // message, the invitation says `failed`, and the operator's retry
      // (`jobs:retry`, `messages:retry`) starts a fresh set of attempts.
      await this.settle(row.id, {
        kind: "failed",
        failure: failure.kind,
        reason: `attempts exhausted (${String(attempt)}): ${reason}`,
      });
      this.logger.warn(
        `Message not sent, attempts exhausted message=${row.id} template=${row.template} kind=${failure.kind} attempts=${String(attempt)}: ${reason}`,
      );
      throw new PermanentJobError(
        `The message ${row.id} was not sent in ${String(attempt)} attempts`,
      );
    }

    await this.settle(row.id, { kind: "failed", failure: failure.kind, reason });
    this.logger.warn(
      `Message refused for good message=${row.id} template=${row.template} kind=${failure.kind}: ${reason}`,
    );
    // Nothing to retry; the message says why, and so does the dead job.
    throw new PermanentJobError(`The message ${row.id} was refused: ${failure.kind}`);
  }

  /**
   * Step 3 and 4 after a successful send: the provider's id first, on its own
   * (so a delivery event that beats the full settle finds the message, and a
   * settle that fails still leaves the message known to be out), then the
   * settle. Each is tried a few times in place. If one keeps failing the job
   * fails and is retried by the queue — and a retry finds the message
   * `sending` (held, then recovered by its claim running out, `sent` when the
   * id was recorded), never `queued`.
   */
  private async recordSent(row: OutboundMessageRow, providerMessageId: string): Promise<void> {
    const provider = this.channel.provider;
    const channel = provider === "test" ? "test" : "whatsapp";
    try {
      await this.tried(async () => {
        await this.database.db
          .update(outboundMessage)
          .set({ providerMessageId, provider, updatedAt: new Date() })
          .where(and(eq(outboundMessage.id, row.id), eq(outboundMessage.status, "sending")));
      });
      await this.tried(() => this.settle(row.id, { kind: "sent", channel, providerMessageId }));
    } catch (error) {
      // The message is out and we could not say so. No number, no text, no
      // provider id in this line: the message id finds the row.
      this.logger.error(
        `Message sent but not recorded message=${row.id} template=${row.template}: ${sanitizeForLog(error instanceof Error ? error.name : "error")}`,
      );
      throw error;
    }
  }

  /** `write`, tried again a few times: the provider already has the message. */
  private async tried(write: () => Promise<void>): Promise<void> {
    let last: unknown;
    for (let attempt = 0; attempt <= RECORD_PAUSES_MS.length; attempt++) {
      try {
        await write();
        return;
      } catch (error) {
        last = error;
        const pause = RECORD_PAUSES_MS[attempt];
        if (pause === undefined) {
          break;
        }
        await sleep(pause);
      }
    }
    throw last;
  }

  /**
   * Step 1. Returns what to send, or why nothing is sent. Every lock this
   * takes is gone when it returns.
   */
  private async claim(messageId: string): Promise<ClaimResult> {
    // One snapshot (see `Messaging.enqueue`).
    const {
      message_send_claim_seconds: claimSeconds,
      message_body_max_length: maxLength,
      message_send_attempts: attemptsSetting,
    } = await this.settings.values();
    return this.database.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(outboundMessage)
        .where(eq(outboundMessage.id, messageId))
        .for("update");
      if (!row) {
        return { kind: "done", reason: "no such message" };
      }
      if (row.status === "sending") {
        const until = row.claimedUntil;
        if (until && until.getTime() > Date.now()) {
          return { kind: "held", until };
        }
        // The claim ran out: an attempt was interrupted. `sent` if the provider's
        // id had been written down, `unknown` if not — never sent from here.
        const outcome = await recoverInterruptedMessage(tx, row, this.subjects, this.logger);
        return { kind: "done", reason: outcome === "sent" ? "recovered as sent" : "interrupted" };
      }
      // `queued` is the ordinary case; `failed` is the operator's retry
      // (`jobs:retry` of a dead job): the provider never took a message that
      // failed, so trying it again cannot double it, and it starts a fresh
      // set of attempts. Everything else — sent, delivered, read, cancelled,
      // and `unknown`, which only a person may decide — is not sent from here.
      if (row.status !== "queued" && row.status !== "failed") {
        return { kind: "done", reason: `already ${row.status}` };
      }
      // The module that owns the subject decides whether it may still go.
      // Inside this transaction on purpose: it may lock what it needs, and
      // the provider is called only after the transaction has committed.
      if (!(await this.subjects.stillSend(tx, row.subjectType, row.subjectId))) {
        await this.write(tx, row, {
          status: "cancelled",
          settledAt: new Date(),
          variables: null,
          claimedUntil: null,
        });
        await this.subjects.onResult(tx, row.subjectType, row.subjectId, { kind: "cancelled" });
        this.logger.log(
          `Message cancelled message=${row.id} template=${row.template}: its subject no longer applies`,
        );
        return { kind: "done", reason: "cancelled" };
      }
      const variables = row.variables ?? {};
      let request: MessageSendRequest;
      try {
        const template = messageTemplate(row.template);
        request = {
          phone: row.phone,
          template: row.template,
          providerTemplateName: template.providerName,
          lang: row.lang,
          variables: orderedVariables(row.template, variables),
          // No quick reply carries a payload yet: acting on a press is
          // TASK-025, which fills them.
          buttons: template.buttons.map((button) => ({ button })),
          text: renderMessageText(row.template, row.lang, variables, maxLength),
        };
      } catch (error) {
        return {
          kind: "render_failed",
          row,
          reason: error instanceof MessageRenderError ? error.reason : "unexpected",
        };
      }
      // A message the operator brings back gets a whole new set of attempts.
      const maxAttempts =
        row.status === "failed" ? row.attempts + attemptsSetting : row.maxAttempts;
      await this.write(tx, row, {
        status: "sending",
        // The row is locked for this transaction, so counting in memory is
        // as sound as counting in SQL and reads plainly.
        attempts: row.attempts + 1,
        maxAttempts,
        settledAt: null,
        failureKind: null,
        claimedUntil: new Date(Date.now() + claimSeconds * 1000),
      });
      return { kind: "send", row, request, maxAttempts };
    });
  }

  /** Step 4, and the final-bad cases. */
  private async settle(messageId: string, outcome: MessageOutcome): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(outboundMessage)
        .where(eq(outboundMessage.id, messageId))
        .for("update");
      if (!row) {
        return;
      }
      const now = new Date();
      if (outcome.kind === "sent") {
        await this.write(tx, row, {
          status: "sent",
          providerMessageId: outcome.providerMessageId,
          provider: this.channel.provider,
          sentAt: now,
          settledAt: now,
          claimedUntil: null,
          // The provider has it: the name and the number in the values are
          // needed for nothing more (ARCHITECTURE 4.35). The test channel
          // sent nothing anywhere, and its rows keep them so
          // `/dev/messages` can show what would have gone out.
          variables: this.channel.provider === "test" ? row.variables : null,
          failureKind: null,
          lastError: null,
        });
      } else if (outcome.kind === "failed") {
        await this.write(tx, row, {
          status: "failed",
          provider: this.channel.provider,
          failureKind: outcome.failure,
          lastError: outcome.reason,
          settledAt: now,
          claimedUntil: null,
          // Kept: retrying a refused message is what the operator does, and
          // `messaging.clear-stale-variables` clears them after
          // `message_variables_retention_days`.
        });
      } else if (outcome.kind === "unknown") {
        await this.write(tx, row, {
          status: "unknown",
          provider: this.channel.provider,
          lastError: outcome.reason.slice(0, 500),
          settledAt: now,
          claimedUntil: null,
        });
      }
      await this.subjects.onResult(tx, row.subjectType, row.subjectId, outcome);
    });
  }

  /** A temporary failure: back to `queued`, the values kept for the retry. */
  private async release(
    messageId: string,
    kind: MessageFailureKind,
    reason: string,
  ): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      const [row] = await tx
        .update(outboundMessage)
        .set({
          status: "queued",
          claimedUntil: null,
          failureKind: null,
          lastError: `${kind}: ${reason}`.slice(0, 500),
          updatedAt: new Date(),
        })
        .where(and(eq(outboundMessage.id, messageId), eq(outboundMessage.status, "sending")))
        .returning();
      if (row) {
        // The module sees each failed attempt, so what it shows the person
        // (an invitation's attempts and last error) stays what it always was.
        await this.subjects.onResult(tx, row.subjectType, row.subjectId, {
          kind: "retrying",
          failure: kind,
          reason,
        });
      }
    });
  }

  private async write(
    tx: DbExecutor,
    row: OutboundMessageRow,
    patch: Partial<typeof outboundMessage.$inferInsert>,
  ): Promise<void> {
    await tx
      .update(outboundMessage)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(outboundMessage.id, row.id));
  }
}
