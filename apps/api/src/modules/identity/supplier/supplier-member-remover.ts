import { Inject, Injectable, Logger } from "@nestjs/common";
import type { DbExecutor } from "../../../database";
import { SessionStore } from "../session/session.store";
import { SupplierMembershipStore } from "./supplier-membership.store";

export interface RemovedMember {
  accountId: string;
  supplierId: string;
  /** Ids of the cabinet sessions that ended with the removal. */
  endedSessionIds: string[];
}

/**
 * The only way to remove an employee (ARCHITECTURE 4.9 I81): the
 * membership is marked removed and every cabinet session bound to it ends
 * — in the caller's transaction, so neither happens without the other.
 * The person's mobile sessions and their sessions in other companies go
 * on. Restoring the membership later brings none of these sessions back.
 */
@Injectable()
export class SupplierMemberRemover {
  private readonly logger = new Logger("SupplierMember");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(SupplierMembershipStore) private readonly memberships: SupplierMembershipStore,
    @Inject(SessionStore) private readonly sessions: SessionStore,
  ) {}

  /** `undefined` if the membership wasn't active. */
  async remove(
    memberId: string,
    removedByMemberId: string | null,
    now: Date,
    tx: DbExecutor,
  ): Promise<RemovedMember | undefined> {
    const removed = await this.memberships.markRemoved(memberId, removedByMemberId, now, tx);
    if (!removed) {
      return undefined;
    }
    const endedSessionIds = await this.sessions.revokeMemberSessions(
      memberId,
      "access_closed",
      now,
      tx,
    );
    return { ...removed, endedSessionIds };
  }

  /** The log lines of a committed removal (never before the commit). */
  logEnded(removed: RemovedMember): void {
    for (const sessionId of removed.endedSessionIds) {
      this.logger.log(
        `Session ended session=${sessionId} account=${removed.accountId} reason=access_closed`,
      );
    }
  }
}
