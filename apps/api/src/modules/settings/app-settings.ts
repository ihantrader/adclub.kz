import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { serviceUnavailableException } from "../../common/errors";
import { describeError } from "../../common/health";
import { APP_CONFIG, type AppConfig } from "../../config";
import { withoutQueryParameters } from "../../database";
import {
  defaultSettingValues,
  isSettingKey,
  settingDefinition,
  type SettingKey,
  type SettingValue,
  type SettingValues,
} from "./registry/registry";
import { checkSettingValue, type SettingCheckContext } from "./registry/setting-definition";
import { SettingsStore, type StoredSetting } from "./settings.store";

export const SETTINGS_CACHE_OPTIONS = Symbol("SETTINGS_CACHE_OPTIONS");

export interface SettingsCacheOptions {
  /**
   * How old the values may be. A change reaches every process within this
   * time: a read never uses values whose query started longer ago.
   */
  maxAgeMs: number;
  /** After a failed read, how long stale values are served before trying again. */
  retryAfterFailureMs: number;
  now: () => number;
}

export const defaultSettingsCacheOptions: SettingsCacheOptions = {
  maxAgeMs: 30_000,
  retryAfterFailureMs: 1_000,
  now: () => Date.now(),
};

export type StoredValueState =
  | { state: "valid"; value: unknown; version: number }
  | { state: "invalid"; reason: "unknown_key" | "invalid_value"; issues: string[] };

/** Checks one stored row against the registry (the same check a change passes). */
export function checkStoredSetting(
  row: StoredSetting,
  context: SettingCheckContext,
): StoredValueState {
  if (!isSettingKey(row.key)) {
    return { state: "invalid", reason: "unknown_key", issues: [] };
  }
  const result = checkSettingValue(settingDefinition(row.key), row.value, context);
  if (!result.ok) {
    return {
      state: "invalid",
      reason: "invalid_value",
      issues: result.issues.map((issue) => `${issue.path}: ${issue.message}`),
    };
  }
  return { state: "valid", value: result.value, version: row.version };
}

interface Snapshot {
  values: SettingValues;
  /** When the query these values came from started. */
  readAt: number;
}

/**
 * The settings in effect in this process (ARCHITECTURE 14, 4.11): the
 * registry defaults overlaid with the stored values that pass their
 * checks, read at most `maxAgeMs` ago.
 *
 * - A stored value that fails its check (edited by hand, or the registry
 *   changed) is not used: the default applies and the log says so, once
 *   per distinct stored value.
 * - If the database can't be read, the last values read are kept (never a
 *   silent fall back to defaults) and the log says so once per outage;
 *   a new read is tried at most every `retryAfterFailureMs`.
 * - If nothing was ever read, reads fail like any other request that
 *   needs the database (`SERVICE_UNAVAILABLE`).
 */
@Injectable()
export class AppSettings implements OnModuleInit {
  private readonly logger = new Logger("Settings");
  private snapshot: Snapshot | undefined;
  private loading: Promise<void> | undefined;
  private lastFailureAt: number | undefined;
  private outage = false;
  /** Stored values already reported as ignored, by key (their JSON). */
  private readonly reported = new Map<string, string>();
  private readonly context: SettingCheckContext;

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(SettingsStore) private readonly store: SettingsStore,
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(SETTINGS_CACHE_OPTIONS) private readonly options: SettingsCacheOptions,
  ) {
    this.context = { adminWebReleaseVersion: config.adminWeb.releaseVersion };
  }

  async onModuleInit(): Promise<void> {
    // Read eagerly so the first request doesn't wait, but never fail
    // startup: a process without its database behaves like any other
    // request that needs it (TASK-007).
    try {
      await this.reload();
    } catch {
      // Already logged by `load`.
    }
  }

  get checkContext(): SettingCheckContext {
    return this.context;
  }

  async get<Key extends SettingKey>(key: Key): Promise<SettingValue<Key>> {
    return (await this.values())[key];
  }

  /** Every setting in effect. Don't modify the returned object. */
  async values(): Promise<Readonly<SettingValues>> {
    const now = this.options.now();
    const snapshot = this.snapshot;
    if (snapshot && now - snapshot.readAt < this.options.maxAgeMs) {
      return snapshot.values;
    }
    const recentlyFailed =
      this.lastFailureAt !== undefined &&
      now - this.lastFailureAt < this.options.retryAfterFailureMs;
    if (snapshot && (this.loading || recentlyFailed)) {
      return snapshot.values;
    }
    if (!snapshot && recentlyFailed && !this.loading) {
      throw serviceUnavailableException();
    }
    try {
      await this.reload();
    } catch {
      if (this.snapshot) {
        return this.snapshot.values;
      }
      throw serviceUnavailableException();
    }
    return this.snapshot!.values;
  }

  /**
   * Reads the stored values now, with a query that starts after this call
   * — after a change in this process, so it applies here at once (and in
   * tests). Throws if the database can't be read.
   */
  async refresh(): Promise<void> {
    if (this.loading) {
      await this.loading.catch(() => undefined);
    }
    await this.reload();
  }

  /**
   * The values read by a query that starts after this call (and the cache
   * updated with them). Throws if the database can't be read.
   */
  async fresh(): Promise<Readonly<SettingValues>> {
    await this.refresh();
    return this.snapshot!.values;
  }

  private reload(): Promise<void> {
    this.loading ??= this.load().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  private async load(): Promise<void> {
    const readAt = this.options.now();
    let rows: StoredSetting[];
    try {
      rows = await this.store.listStored();
    } catch (error) {
      this.lastFailureAt = this.options.now();
      if (!this.outage) {
        this.outage = true;
        const kept = this.snapshot
          ? `keeping the values read at ${new Date(this.snapshot.readAt).toISOString()}`
          : "no values were read yet";
        this.logger.warn(
          `Settings could not be read, ${kept}: ${describeError(withoutQueryParameters(error))}`,
        );
      }
      throw error;
    }
    if (this.outage) {
      this.outage = false;
      this.logger.log("Settings read again after a failure");
    }
    this.lastFailureAt = undefined;

    const values = defaultSettingValues() as Record<string, unknown>;
    const seen = new Set<string>();
    for (const row of rows) {
      seen.add(row.key);
      const checked = checkStoredSetting(row, this.context);
      if (checked.state === "valid") {
        values[row.key] = checked.value;
        this.reported.delete(row.key);
        continue;
      }
      const fingerprint = JSON.stringify(row.value);
      if (this.reported.get(row.key) !== fingerprint) {
        this.reported.set(row.key, fingerprint);
        this.logger.warn(
          checked.reason === "unknown_key"
            ? `Stored setting ignored key=${row.key} reason=unknown_key`
            : `Stored setting ignored, the default applies key=${row.key} version=${row.version} reason=invalid_value issues=${checked.issues.join("; ")}`,
        );
      }
    }
    for (const key of this.reported.keys()) {
      if (!seen.has(key)) {
        this.reported.delete(key);
      }
    }
    this.snapshot = { values: values as SettingValues, readAt };
  }
}
