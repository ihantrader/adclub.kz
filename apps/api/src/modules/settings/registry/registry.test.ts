import { readFileSync } from "node:fs";
import { join } from "node:path";
import { settingKeySchema } from "@adclub/contracts";
import { describe, expect, it } from "vitest";
import {
  ADMIN_SESSION_MAX_SECONDS,
  SIGN_IN_STEP_MAX_SECONDS,
  defaultSettingValues,
  isSettingKey,
  settingDefinitions,
  settingGroups,
} from "./registry";
import { checkSettingValue, describeConstraints } from "./setting-definition";

const context = { adminWebReleaseVersion: "0.1.0" };
const definitions = Object.entries(settingDefinitions);

/** Setting keys named in the table of ARCHITECTURE.md section 14 (with `app_setting` as the store). */
function architectureSection14Keys(): string[] {
  const architecture = readFileSync(join(__dirname, "../../../../../../ARCHITECTURE.md"), "utf8");
  const section = architecture.slice(
    architecture.indexOf("## 14. Изменяемая конфигурация"),
    architecture.indexOf("## 15. Нефункциональные аспекты"),
  );
  const keys = new Set<string>();
  for (const line of section.split("\n")) {
    const cells = line.split("|");
    if (cells.length < 4 || !cells[2]?.includes("app_setting")) {
      continue;
    }
    for (const match of cells[3]!.matchAll(/`([a-z][a-z0-9_]*)`/g)) {
      // Example values (`false`) aren't keys.
      if (match[1] !== "false" && match[1] !== "true") {
        keys.add(match[1]!);
      }
    }
  }
  return [...keys];
}

describe("settings registry", () => {
  it("has exactly the keys ARCHITECTURE 14 lists", () => {
    expect(architectureSection14Keys().sort()).toEqual(Object.keys(settingDefinitions).sort());
  });

  it("has the groups of SCREENS A-SET-01 and A-SET-02", () => {
    expect(settingGroups.map((group) => group.id)).toEqual([
      "orders",
      "notifications",
      "guest_assistant",
      "ai",
      "translation",
      "rating",
      "pricelist",
      "reviews",
      "photos",
      "vehicles",
      "compatibility",
      "suppliers",
      "offers",
      "showcase",
      "public_limits",
      "messages",
      "billing",
      "clients",
      "cleanup",
      "login_code",
      "session",
      "sign_in",
    ]);
    for (const key of [
      "supplier_response_hours",
      "order_late_close_hours",
      "max_notified_members",
      "whatsapp_fallback_minutes",
      "guest_limits",
      "assistant_daily_dialogs_per_user",
      "rating_min_reviews",
      "rating_weights",
      "price_match_confidence_threshold",
      "price_change_threshold_percent",
      "review_check_max_wait_minutes",
      "photo_display_mode",
      "client_min_version_ios",
      "client_min_version_android",
      "client_min_version_supplier_web",
      "client_min_version_admin_web",
      "client_update_message",
      "cleanup_login_code_retention_days",
      "cleanup_sign_in_step_retention_days",
      "cleanup_session_retention_days",
    ]) {
      expect(isSettingKey(key), key).toBe(true);
    }
  });

  it("describes every key completely, and every default passes its own check", () => {
    for (const [key, definition] of definitions) {
      expect(settingKeySchema.safeParse(key).success, key).toBe(true);
      expect(definition.description.length, key).toBeGreaterThan(10);
      expect(
        settingGroups.some((group) => group.id === definition.group),
        key,
      ).toBe(true);
      const checked = checkSettingValue(definition, definition.default, context);
      expect(checked, key).toEqual({ ok: true, value: definition.default });
      expect(describeConstraints(definition, context), key).toBeDefined();
      if ("min" in definition) {
        expect(definition.min, key).toBeLessThanOrEqual(definition.max);
      }
    }
    // Groups and the flat map hold the same keys, each once.
    const grouped = settingGroups.flatMap((group) => Object.keys(group.settings));
    expect(new Set(grouped).size).toBe(grouped.length);
    expect(grouped.sort()).toEqual(Object.keys(settingDefinitions).sort());
  });

  it("lets only the operator command change the sign-in security settings (D-053)", () => {
    const security = /^(login_code_|session_|sign_in_|admin_totp_|admin_backup_code_count$)/;
    for (const [key, definition] of definitions) {
      expect(definition.editableBy, key).toBe(security.test(key) ? "operator" : "admin");
    }
  });

  it("keeps the hard safety limits whatever value is stored", () => {
    const admin = settingDefinitions.session_admin_web_ttl_seconds;
    expect(ADMIN_SESSION_MAX_SECONDS).toBe(12 * 60 * 60);
    expect(admin.max).toBe(ADMIN_SESSION_MAX_SECONDS);
    expect(checkSettingValue(admin, ADMIN_SESSION_MAX_SECONDS + 1, context).ok).toBe(false);
    expect(SIGN_IN_STEP_MAX_SECONDS).toBe(30 * 60);
    for (const definition of [
      settingDefinitions.sign_in_supplier_selection_ttl_seconds,
      settingDefinitions.sign_in_admin_totp_ttl_seconds,
    ]) {
      expect(definition.max).toBe(SIGN_IN_STEP_MAX_SECONDS);
      expect(checkSettingValue(definition, SIGN_IN_STEP_MAX_SECONDS + 1, context).ok).toBe(false);
      expect(checkSettingValue(definition, 0, context).ok).toBe(false);
    }
    // The login code thresholds keep the bounds the environment had.
    expect(checkSettingValue(settingDefinitions.login_code_length, 3, context).ok).toBe(false);
    expect(checkSettingValue(settingDefinitions.login_code_length, 9, context).ok).toBe(false);
    expect(checkSettingValue(settingDefinitions.admin_backup_code_count, 0, context).ok).toBe(
      false,
    );
    expect(
      checkSettingValue(settingDefinitions.admin_totp_allowed_drift_steps, 6, context).ok,
    ).toBe(false);
  });

  it("keeps the retention of stale sign-in data the Product Owner approved (D-054)", () => {
    expect(settingDefinitions.cleanup_login_code_retention_days).toMatchObject({
      group: "cleanup",
      unit: "days",
      default: 7,
      editableBy: "admin",
    });
    expect(settingDefinitions.cleanup_sign_in_step_retention_days.default).toBe(1);
    expect(settingDefinitions.cleanup_session_retention_days.default).toBe(30);
    // A retention below a day would delete data still covered by the
    // sign-in flows that use it.
    for (const key of [
      "cleanup_login_code_retention_days",
      "cleanup_sign_in_step_retention_days",
      "cleanup_session_retention_days",
    ] as const) {
      expect(checkSettingValue(settingDefinitions[key], 0, context).ok, key).toBe(false);
    }
  });

  it("gives a fresh copy of the defaults each time", () => {
    const first = defaultSettingValues();
    first.guest_limits.photo_recognitions = 99;
    expect(defaultSettingValues().guest_limits.photo_recognitions).toBe(3);
    expect(settingDefinitions.guest_limits.default.photo_recognitions).toBe(3);
  });
});
