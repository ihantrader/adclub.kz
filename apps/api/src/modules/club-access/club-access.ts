import { Inject, Injectable } from "@nestjs/common";
import type { ClubAccessState } from "@adclub/contracts";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { DatabaseService, type DbExecutor } from "../../database";
import { clubAccessGrant } from "./schema";

const NONE: ClubAccessState = { granted: false, source: null, validUntil: null };

/**
 * Whether an account has club access now (D-059; ARCHITECTURE 4.29) — the
 * one function every rule of visibility asks (the names of suppliers and
 * the points of their offers, TASK-020; orders, EPIC-08). A guest has none.
 *
 * The only source until the stores' subscriptions (EPIC-14): a grant by
 * hand that isn't ended and whose end is still ahead. TASK-040 adds the
 * subscription here; callers don't change. Nothing is cached: an access
 * that ends while a session lasts is gone on the very next request.
 */
@Injectable()
export class ClubAccess {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async stateOf(
    accountId: string | null,
    executor: DbExecutor = this.database.db,
    at: Date = new Date(),
  ): Promise<ClubAccessState> {
    if (accountId === null) {
      return NONE;
    }
    const [grant] = await executor
      .select({ validUntil: clubAccessGrant.validUntil, source: clubAccessGrant.source })
      .from(clubAccessGrant)
      .where(
        and(
          eq(clubAccessGrant.accountId, accountId),
          isNull(clubAccessGrant.endedAt),
          gt(clubAccessGrant.validUntil, at),
        ),
      )
      .orderBy(desc(clubAccessGrant.validUntil))
      .limit(1);
    return grant
      ? { granted: true, source: grant.source, validUntil: grant.validUntil.toISOString() }
      : NONE;
  }

  /** `stateOf(…).granted`. */
  async has(accountId: string | null, executor?: DbExecutor): Promise<boolean> {
    return (await this.stateOf(accountId, executor)).granted;
  }
}
