import { Inject, Injectable } from "@nestjs/common";
import type { AccountConsent, ConsentKindValue } from "@adclub/contracts";
import {
  latestConsents,
  outdatedConsents,
  type ConsentKind,
  type ConsentVersions,
} from "@adclub/domain";
import { and, desc, eq, sql } from "drizzle-orm";
import { DatabaseService, type DbExecutor } from "../../../database";
import { accountConsent, session, type AccountConsentClient } from "../schema";

/**
 * The current versions of the texts (the settings consent_<kind>_version),
 * provided by the settings module (TASK-007 pattern: identity does not import it).
 */
export abstract class ConsentVersionsSource {
  abstract currentVersions(): Promise<ConsentVersions>;
}

/** Where a consent comes from: the session it was given in. */
export interface ConsentSource {
  sessionId: string;
}

/** What the profile says about the consents of an account. */
export interface ConsentState {
  consents: AccountConsent[];
  outdated: ConsentKind[];
}

/**
 * The journal of consents of an account (TASK-072, D-077; ARCHITECTURE
 * 4.96): every consent given is a row — what, which version of the text,
 * when, from which client and platform; the current state («Мои согласия»,
 * `consentsOutdated`, the gate of orders) is read from it. The current
 * versions are settings (`consent_<kind>_version`): the server records its
 * own version, never one a client names.
 */
@Injectable()
export class AccountConsents {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ConsentVersionsSource) private readonly versions: ConsentVersionsSource,
  ) {}

  currentVersions(): Promise<ConsentVersions> {
    return this.versions.currentVersions();
  }

  /**
   * Records the consents for their current versions, in the caller's
   * transaction. A kind whose last consent is already of the current
   * version is not written again unless `again` (the registration, which
   * the member confirms each time it is sent).
   */
  async give(
    tx: DbExecutor,
    accountId: string,
    kinds: readonly ConsentKind[],
    source: ConsentSource | null,
    options: { at?: Date; again?: boolean } = {},
  ): Promise<{ kind: ConsentKind; version: string }[]> {
    if (kinds.length === 0) {
      return [];
    }
    const versions = await this.currentVersions();
    const latest = latestConsents(await this.journal(accountId, tx));
    const wanted = [...new Set(kinds)].filter(
      (kind) => options.again === true || latest[kind]?.version !== versions[kind],
    );
    if (wanted.length === 0) {
      return [];
    }
    const origin = source ? await this.originOf(tx, source.sessionId) : null;
    const at = options.at ?? new Date();
    await tx.insert(accountConsent).values(
      wanted.map((kind) => ({
        accountId,
        kind,
        version: versions[kind],
        givenAt: at,
        client: origin?.client ?? "mobile",
        platform: origin?.platform ?? null,
      })),
    );
    return wanted.map((kind) => ({ kind, version: versions[kind] }));
  }

  /** Every consent of the account, the latest first. */
  async journal(
    accountId: string,
    executor: DbExecutor = this.database.db,
  ): Promise<{ kind: ConsentKind; version: string; at: Date }[]> {
    const rows = await executor
      .select({
        kind: accountConsent.kind,
        version: accountConsent.version,
        at: accountConsent.givenAt,
      })
      .from(accountConsent)
      .where(eq(accountConsent.accountId, accountId))
      .orderBy(desc(accountConsent.givenAt), desc(accountConsent.createdAt));
    return rows;
  }

  /** «Мои согласия» and what must be agreed to again. */
  async state(accountId: string, executor: DbExecutor = this.database.db): Promise<ConsentState> {
    const [journal, versions, stores] = await Promise.all([
      this.journal(accountId, executor),
      this.currentVersions(),
      this.storesVehicleDocument(accountId, executor),
    ]);
    return {
      consents: journal.map((entry) => ({
        kind: entry.kind as ConsentKindValue,
        version: entry.version,
        at: entry.at.toISOString(),
        current: entry.version === versions[entry.kind],
      })),
      outdated: outdatedConsents(journal, versions, { storesVehicleDocument: stores }),
    };
  }

  /** D-064: whether the garage keeps a VIN or a plate number. */
  private async storesVehicleDocument(accountId: string, executor: DbExecutor): Promise<boolean> {
    const rows = await executor.execute<{ stores: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM account_car
        WHERE account_id = ${accountId} AND (vin IS NOT NULL OR plate IS NOT NULL)
      ) AS stores`);
    return Boolean(rows.rows[0]?.stores);
  }

  private async originOf(
    executor: DbExecutor,
    sessionId: string,
  ): Promise<{ client: AccountConsentClient; platform: string | null } | null> {
    const [row] = await executor
      .select({ kind: session.kind, platform: session.clientPlatform })
      .from(session)
      .where(and(eq(session.id, sessionId)));
    if (!row) {
      return null;
    }
    return { client: row.kind, platform: row.platform?.slice(0, 20) ?? null };
  }
}
