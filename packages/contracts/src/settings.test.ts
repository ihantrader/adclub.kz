import { describe, expect, it } from "vitest";
import { apiRoutes } from "./routes";
import {
  changeSettingBodySchema,
  resetSettingBodySchema,
  settingActorSchema,
  settingKeyPathSchema,
} from "./settings";

describe("settings contract", () => {
  it("requires a value, the version it replaces and a reason for a change", () => {
    const valid = { value: 5, expectedVersion: 0, reason: "Бюджет ИИ" };
    expect(changeSettingBodySchema.parse(valid)).toEqual(valid);
    expect(changeSettingBodySchema.safeParse({ ...valid, value: null }).success).toBe(true);
    expect(changeSettingBodySchema.parse({ ...valid, reason: "  Бюджет  " }).reason).toBe("Бюджет");
    const { value: _value, ...withoutValue } = valid;
    expect(changeSettingBodySchema.safeParse(withoutValue).success).toBe(false);
    expect(changeSettingBodySchema.safeParse({ ...valid, expectedVersion: -1 }).success).toBe(
      false,
    );
    expect(changeSettingBodySchema.safeParse({ ...valid, expectedVersion: 1.5 }).success).toBe(
      false,
    );
    expect(changeSettingBodySchema.safeParse({ ...valid, reason: "  " }).success).toBe(false);
    expect(changeSettingBodySchema.safeParse({ ...valid, reason: "x".repeat(501) }).success).toBe(
      false,
    );
    expect(resetSettingBodySchema.safeParse({ expectedVersion: 2, reason: "Сброс" }).success).toBe(
      true,
    );
    expect(resetSettingBodySchema.safeParse({ reason: "Сброс" }).success).toBe(false);
  });

  it("accepts only snake_case keys in the path", () => {
    expect(settingKeyPathSchema.safeParse({ key: "rating_min_reviews" }).success).toBe(true);
    for (const key of ["", "Rating", "rating-min", "../admin", "1key", "a".repeat(65)]) {
      expect(settingKeyPathSchema.safeParse({ key }).success, key).toBe(false);
    }
  });

  it("names who changed a setting", () => {
    expect(settingActorSchema.parse({ kind: "operator" })).toEqual({ kind: "operator" });
    expect(
      settingActorSchema.safeParse({ kind: "admin", adminId: "x", phoneMasked: null }).success,
    ).toBe(false);
  });

  it("serves the settings routes to administrators only, even to an outdated admin panel", () => {
    for (const route of [
      apiRoutes.listSettings,
      apiRoutes.changeSetting,
      apiRoutes.resetSetting,
      apiRoutes.getSettingHistory,
    ]) {
      expect(route.auth).toBe("session");
      expect(route.contexts).toEqual(["admin"]);
      expect(route.clientVersionCheck).toBe("enforced_except_admin_web");
    }
    // What an administrator needs to sign in with an outdated admin panel.
    for (const route of [
      apiRoutes.requestLoginCode,
      apiRoutes.verifyLoginCode,
      apiRoutes.startTotpSetup,
      apiRoutes.confirmTotpSetup,
      apiRoutes.verifyTotp,
      apiRoutes.refreshSession,
      apiRoutes.getCurrentAccount,
      apiRoutes.logout,
    ]) {
      expect(route.clientVersionCheck, route.operationId).toBe("enforced_except_admin_web");
    }
    expect(apiRoutes.listAdministrators.clientVersionCheck).toBe("enforced");
    expect(apiRoutes.selectSupplier.clientVersionCheck).toBe("enforced");
  });
});
