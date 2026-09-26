import { Injectable } from "@nestjs/common";
import type { DbExecutor } from "../../database";
import type { MessageFailureKind } from "./message-channel";

/**
 * What a module tells messaging about the thing its messages are about
 * (TASK-024 requirements 3 and 5). Messaging owns the queue, the claim,
 * the provider and the delivery; it knows nothing of suppliers or orders —
 * so the two questions only the owning module can answer are asked through
 * this registry, the same shape as `JobRegistry` for jobs:
 *
 * 1. `stillSend` — may this message still go? (An invitation whose employee
 *    was removed between being queued and being sent must not go out.) It
 *    runs inside the short transaction that claims the message, so it may
 *    lock the rows it needs; the provider is called after that transaction
 *    has committed, never under its locks.
 * 2. `onResult` — the message is settled: keep whatever the module keeps
 *    about it. Runs in the transaction that settles the message, so the two
 *    can never disagree.
 */

/** What became of a message (`onResult`). */
export type MessageOutcome =
  | { kind: "sent"; channel: "test" | "whatsapp"; providerMessageId: string }
  | { kind: "failed"; failure: MessageFailureKind | "render_failed"; reason: string }
  /** An attempt failed and the message goes back on the queue (not final). */
  | { kind: "retrying"; failure: MessageFailureKind; reason: string }
  | { kind: "cancelled" }
  | { kind: "unknown"; reason: string };

export interface MessageSubject {
  /**
   * `false` — the message is cancelled and nothing is sent. Called with the
   * subject's id; `null` when the message names no subject row.
   */
  stillSend(tx: DbExecutor, subjectId: string | null): Promise<boolean>;
  onResult(tx: DbExecutor, subjectId: string | null, outcome: MessageOutcome): Promise<void>;
}

/**
 * The subjects messages can be about, in this process. A module registers
 * its own in `onModuleInit`; a message whose subject type nobody registered
 * is still sent (there is nothing to ask), which keeps a message of a
 * module the worker doesn't load from being silently cancelled.
 */
@Injectable()
export class MessageSubjects {
  private readonly subjects = new Map<string, MessageSubject>();

  register(type: string, subject: MessageSubject): void {
    if (this.subjects.has(type)) {
      throw new Error(`The message subject ${type} is registered twice`);
    }
    this.subjects.set(type, subject);
  }

  get(type: string): MessageSubject | undefined {
    return this.subjects.get(type);
  }

  async stillSend(tx: DbExecutor, type: string, subjectId: string | null): Promise<boolean> {
    const subject = this.subjects.get(type);
    return subject ? subject.stillSend(tx, subjectId) : true;
  }

  async onResult(
    tx: DbExecutor,
    type: string,
    subjectId: string | null,
    outcome: MessageOutcome,
  ): Promise<void> {
    await this.subjects.get(type)?.onResult(tx, subjectId, outcome);
  }
}
