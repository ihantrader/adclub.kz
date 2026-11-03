import type { DbExecutor } from "../database";
import type { SettingValues } from "../modules/settings";

/**
 * Settings as the job runner reads them (schedules). Provided by the
 * global settings module (`AppSettings`), so this directory depends on it
 * only by type — modules that declare jobs are imported by the settings
 * module themselves.
 */
export abstract class JobSettingsReader {
  /**
   * The stored settings read by a query that starts after this call — never
   * the cached values, which may be up to 30 seconds old and differ from
   * worker to worker (TASK-011.A: a worker with a stale cache put a changed
   * schedule back). Read on the caller's open transaction, never on another
   * pool connection while it is open (I844). Throws if the database can't be read.
   */
  abstract freshWithin(executor: DbExecutor): Promise<Readonly<SettingValues>>;
}
