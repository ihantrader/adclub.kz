import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiException } from "../../common/errors";
import type { AppConfig } from "../../config";
import { AppSettings, defaultSettingsCacheOptions } from "./app-settings";
import type { SettingsStore, StoredSetting } from "./settings.store";

/** A store the test fills, breaks and counts reads of. */
class FakeStore {
  rows: StoredSetting[] = [];
  failing = false;
  reads = 0;
  pending: (() => void) | undefined;
  hold = false;

  async listStored(): Promise<StoredSetting[]> {
    this.reads += 1;
    if (this.hold) {
      await new Promise<void>((resolve) => {
        this.pending = resolve;
      });
    }
    if (this.failing) {
      throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
    }
    return this.rows.map((row) => ({ ...row }));
  }
}

const config = { adminWeb: { releaseVersion: "0.1.0" } } as AppConfig;

describe("AppSettings", () => {
  let store: FakeStore;
  let now: number;
  let settings: AppSettings;
  let warnings: string[];

  beforeEach(() => {
    store = new FakeStore();
    now = 1_000_000;
    settings = new AppSettings(store as unknown as SettingsStore, config, {
      ...defaultSettingsCacheOptions,
      now: () => now,
    });
    warnings = [];
    const logger = (settings as unknown as { logger: { warn: unknown; log: unknown } }).logger;
    vi.spyOn(logger as { warn: (message: string) => void }, "warn").mockImplementation(
      (message: string) => warnings.push(message),
    );
    vi.spyOn(logger as { log: (message: string) => void }, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("serves the defaults overlaid with stored values", async () => {
    store.rows = [{ key: "assistant_daily_dialogs_per_user", value: 7, version: 3 }];
    expect(await settings.get("assistant_daily_dialogs_per_user")).toBe(7);
    expect(await settings.get("rating_min_reviews")).toBe(5);
    expect((await settings.values()).guest_limits).toEqual({
      photo_recognitions: 3,
      voice_requests: 5,
      assistant_dialogs: 3,
    });
  });

  it("applies a change in the store within 30 seconds, and reads at most that often", async () => {
    await settings.values();
    expect(store.reads).toBe(1);
    store.rows = [{ key: "login_code_requests_per_phone", value: 2, version: 1 }];

    now += 29_999;
    expect(await settings.get("login_code_requests_per_phone")).toBe(5);
    expect(store.reads).toBe(1);

    now += 1;
    expect(await settings.get("login_code_requests_per_phone")).toBe(2);
    expect(store.reads).toBe(2);
  });

  it("counts the age from when the read started, not when it finished", async () => {
    store.hold = true;
    const first = settings.values();
    now += 10_000; // a slow query
    store.pending!();
    await first;
    store.hold = false;
    now += 20_000; // 30 s after the read started
    await settings.values();
    expect(store.reads).toBe(2);
  });

  it("applies a change made in this process at once with refresh()", async () => {
    await settings.values();
    store.rows = [{ key: "rating_min_reviews", value: 9, version: 1 }];
    await settings.refresh();
    expect(await settings.get("rating_min_reviews")).toBe(9);
  });

  it("refresh() never returns the result of a read that started before it", async () => {
    await settings.values();
    now += 30_000;
    store.hold = true;
    const stale = settings.values(); // starts a read with the old rows
    const readsBefore = store.reads;
    store.rows = [{ key: "rating_min_reviews", value: 11, version: 1 }];
    const refreshed = settings.refresh();
    store.hold = false;
    store.pending!();
    await stale;
    await refreshed;
    expect(store.reads).toBe(readsBefore + 1);
    expect(await settings.get("rating_min_reviews")).toBe(11);
  });

  it("ignores an invalid or unknown stored value, logging it once", async () => {
    store.rows = [
      { key: "session_admin_web_ttl_seconds", value: 86_400, version: 2 },
      { key: "client_update_message", value: { ru: "Обновите", kk: "", en: "Update" }, version: 1 },
      { key: "removed_setting", value: 1, version: 1 },
      { key: "guest_limits", value: { photo_recognitions: 1 }, version: 1 },
    ];
    const values = await settings.values();
    expect(values.session_admin_web_ttl_seconds).toBe(12 * 60 * 60);
    expect(values.client_update_message.ru).toContain("не поддерживается");
    expect(values.guest_limits.photo_recognitions).toBe(3);
    expect(warnings).toHaveLength(4);
    expect(warnings.join("\n")).toContain(
      "Stored setting ignored, the default applies key=session_admin_web_ttl_seconds version=2 reason=invalid_value",
    );
    expect(warnings.join("\n")).toContain("key=removed_setting reason=unknown_key");
    expect(warnings.join("\n")).not.toContain("86400");

    now += 30_000;
    await settings.values();
    expect(warnings).toHaveLength(4);

    // A different broken value is reported again; a fixed one is used.
    store.rows = [
      { key: "session_admin_web_ttl_seconds", value: "12h", version: 3 },
      {
        key: "guest_limits",
        value: { photo_recognitions: 1, voice_requests: 1, assistant_dialogs: 1 },
        version: 2,
      },
    ];
    now += 30_000;
    const again = await settings.values();
    expect(warnings).toHaveLength(5);
    expect(again.guest_limits.photo_recognitions).toBe(1);
  });

  it("keeps the last values while the database is down and never falls back to defaults", async () => {
    store.rows = [{ key: "client_min_version_android", value: "2.0.0", version: 1 }];
    expect(await settings.get("client_min_version_android")).toBe("2.0.0");

    store.failing = true;
    now += 30_000;
    expect(await settings.get("client_min_version_android")).toBe("2.0.0");
    expect(warnings).toEqual([
      expect.stringContaining("Settings could not be read, keeping the values read at"),
    ]);
    // Not retried on every call…
    const reads = store.reads;
    now += 500;
    expect(await settings.get("client_min_version_android")).toBe("2.0.0");
    expect(store.reads).toBe(reads);
    // …but again after a pause, and logged once per outage.
    now += 1_000;
    expect(await settings.get("client_min_version_android")).toBe("2.0.0");
    expect(store.reads).toBe(reads + 1);
    expect(warnings).toHaveLength(1);
    await expect(settings.refresh()).rejects.toThrow("ECONNREFUSED");

    store.failing = false;
    store.rows = [];
    now += 1_000;
    expect(await settings.get("client_min_version_android")).toBe("0.0.0");
  });

  it("fails like any request that needs the database when nothing was ever read", async () => {
    store.failing = true;
    await settings.onModuleInit();
    expect(warnings).toEqual([
      expect.stringContaining("Settings could not be read, no values were read yet"),
    ]);
    const refused = await settings.values().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ApiException);
    expect(refused).toMatchObject({ status: 503, code: "SERVICE_UNAVAILABLE" });

    store.failing = false;
    now += 1_000;
    expect(await settings.get("rating_min_reviews")).toBe(5);
  });

  it("never fails startup when the database is down", async () => {
    store.failing = true;
    await expect(settings.onModuleInit()).resolves.toBeUndefined();
  });
});
