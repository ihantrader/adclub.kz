import { Inject, Injectable } from "@nestjs/common";
import { desc, eq, sql } from "drizzle-orm";
import { DatabaseService, type DbExecutor } from "../../database";
import {
  appSetting,
  appSettingChange,
  type SettingActorKind,
  type SettingChangeAction,
} from "./schema";

export interface StoredSetting {
  key: string;
  value: unknown;
  version: number;
}

export interface SettingChangeRecord {
  id: string;
  key: string;
  version: number;
  action: SettingChangeAction;
  previousValue: unknown;
  previousIsDefault: boolean;
  newValue: unknown;
  newIsDefault: boolean;
  reason: string;
  actorKind: SettingActorKind;
  actorAdminId: string | null;
  actorAccountId: string | null;
  createdAt: Date;
}

export type SettingActorRecord =
  { kind: "admin"; adminId: string; accountId: string } | { kind: "operator" };

export interface NewSettingChange {
  key: string;
  version: number;
  action: SettingChangeAction;
  previousValue: unknown;
  previousIsDefault: boolean;
  newValue: unknown;
  newIsDefault: boolean;
  reason: string;
  actor: SettingActorRecord;
}

const changeColumns = {
  id: appSettingChange.id,
  key: appSettingChange.key,
  version: appSettingChange.version,
  action: appSettingChange.action,
  previousValue: appSettingChange.previousValue,
  previousIsDefault: appSettingChange.previousIsDefault,
  newValue: appSettingChange.newValue,
  newIsDefault: appSettingChange.newIsDefault,
  reason: appSettingChange.reason,
  actorKind: appSettingChange.actorKind,
  actorAdminId: appSettingChange.actorAdminId,
  actorAccountId: appSettingChange.actorAccountId,
  createdAt: appSettingChange.createdAt,
};

/** How many history entries one request returns at most. */
export const SETTING_HISTORY_LIMIT = 200;

/** Persistence of `app_setting` and `app_setting_change` (ARCHITECTURE 4.11). */
@Injectable()
export class SettingsStore {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /** Every stored value (the cache reads this). */
  listStored(executor: DbExecutor = this.database.db): Promise<StoredSetting[]> {
    return executor
      .select({ key: appSetting.key, value: appSetting.value, version: appSetting.version })
      .from(appSetting);
  }

  /** The latest change of every key that has one. */
  async latestChanges(executor: DbExecutor = this.database.db): Promise<SettingChangeRecord[]> {
    return executor
      .selectDistinctOn([appSettingChange.key], changeColumns)
      .from(appSettingChange)
      .orderBy(appSettingChange.key, desc(appSettingChange.version));
  }

  /**
   * Serializes changes of one key until the transaction ends (the row may
   * not exist, so a row lock can't do it).
   */
  async lockKey(key: string, executor: DbExecutor): Promise<void> {
    await executor.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`app_setting:${key}`}, 0))`,
    );
  }

  async findStored(key: string, executor: DbExecutor): Promise<StoredSetting | undefined> {
    const [row] = await executor
      .select({ key: appSetting.key, value: appSetting.value, version: appSetting.version })
      .from(appSetting)
      .where(eq(appSetting.key, key));
    return row;
  }

  /** The key's current version: its latest history entry, 0 without any. */
  async currentVersion(key: string, executor: DbExecutor): Promise<number> {
    const [row] = await executor
      .select({ version: sql<number>`coalesce(max(${appSettingChange.version}), 0)::int` })
      .from(appSettingChange)
      .where(eq(appSettingChange.key, key));
    return row?.version ?? 0;
  }

  async write(
    key: string,
    value: unknown,
    version: number,
    actor: SettingActorRecord,
    executor: DbExecutor,
  ): Promise<void> {
    const by = {
      version,
      value,
      updatedByKind: actor.kind,
      updatedByAdminId: actor.kind === "admin" ? actor.adminId : null,
      updatedAt: sql`now()`,
    };
    await executor
      .insert(appSetting)
      .values({ key, ...by })
      .onConflictDoUpdate({ target: appSetting.key, set: by });
  }

  async remove(key: string, executor: DbExecutor): Promise<void> {
    await executor.delete(appSetting).where(eq(appSetting.key, key));
  }

  async appendChange(change: NewSettingChange, executor: DbExecutor): Promise<SettingChangeRecord> {
    const [row] = await executor
      .insert(appSettingChange)
      .values({
        key: change.key,
        version: change.version,
        action: change.action,
        previousValue: change.previousValue,
        previousIsDefault: change.previousIsDefault,
        newValue: change.newValue,
        newIsDefault: change.newIsDefault,
        reason: change.reason,
        actorKind: change.actor.kind,
        actorAdminId: change.actor.kind === "admin" ? change.actor.adminId : null,
        actorAccountId: change.actor.kind === "admin" ? change.actor.accountId : null,
      })
      .returning(changeColumns);
    if (!row) {
      throw new Error("Setting change was not recorded");
    }
    return row;
  }

  history(key: string, executor: DbExecutor = this.database.db): Promise<SettingChangeRecord[]> {
    return executor
      .select(changeColumns)
      .from(appSettingChange)
      .where(eq(appSettingChange.key, key))
      .orderBy(desc(appSettingChange.version))
      .limit(SETTING_HISTORY_LIMIT);
  }
}
