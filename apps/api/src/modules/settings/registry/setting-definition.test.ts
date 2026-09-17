import { describe, expect, it } from "vitest";
import { settingDefinitions as d } from "./registry";
import { checkSettingValue, describeConstraints } from "./setting-definition";

const context = { adminWebReleaseVersion: "1.2.0" };
const accepts = (definition: Parameters<typeof checkSettingValue>[0], value: unknown) =>
  checkSettingValue(definition, value, context).ok;

describe("checkSettingValue", () => {
  it("checks whole numbers and durations against their range", () => {
    expect(accepts(d.assistant_daily_dialogs_per_user, 20)).toBe(true);
    expect(accepts(d.assistant_daily_dialogs_per_user, 0)).toBe(false);
    expect(accepts(d.assistant_daily_dialogs_per_user, 1001)).toBe(false);
    expect(accepts(d.assistant_daily_dialogs_per_user, 2.5)).toBe(false);
    expect(accepts(d.assistant_daily_dialogs_per_user, "20")).toBe(false);
    expect(accepts(d.supplier_response_hours, 49)).toBe(false);
    expect(accepts(d.supplier_response_hours, null)).toBe(false);
  });

  it("checks fractional numbers", () => {
    expect(accepts(d.whatsapp_outage_error_ratio, 0.25)).toBe(true);
    expect(accepts(d.whatsapp_outage_error_ratio, 1.5)).toBe(false);
    expect(accepts(d.guest_ai_daily_budget_usd, 12.5)).toBe(true);
    expect(accepts(d.guest_ai_daily_budget_usd, Number.NaN)).toBe(false);
  });

  it("checks yes/no, strings and allowed values", () => {
    expect(accepts(d.guest_attestation_required, true)).toBe(true);
    expect(accepts(d.guest_attestation_required, "true")).toBe(false);
    expect(checkSettingValue(d.default_city, "  Астана ", context)).toEqual({
      ok: true,
      value: "Астана",
    });
    expect(accepts(d.default_city, "   ")).toBe(false);
    expect(accepts(d.default_city, "x".repeat(101))).toBe(false);
    expect(accepts(d.photo_display_mode, "copy")).toBe(true);
    expect(accepts(d.photo_display_mode, "embed")).toBe(false);
  });

  it("requires all three languages of a text, none of them empty", () => {
    const text = { kk: "Жаңартыңыз", ru: "Обновите", en: "Update" };
    expect(accepts(d.client_update_message, text)).toBe(true);
    expect(accepts(d.client_update_message, { ...text, kk: "  " })).toBe(false);
    const { en: _en, ...withoutEnglish } = text;
    const missing = checkSettingValue(d.client_update_message, withoutEnglish, context);
    expect(missing).toMatchObject({ ok: false, issues: [{ path: "value.en" }] });
    expect(accepts(d.client_update_message, { ...text, de: "Aktualisieren" })).toBe(false);
    expect(accepts(d.client_update_message, "Обновите")).toBe(false);
  });

  it("checks a composite value by its schema: no missing and no extra fields", () => {
    const limits = { photo_recognitions: 3, voice_requests: 5, assistant_dialogs: 3 };
    expect(accepts(d.guest_limits, limits)).toBe(true);
    const { voice_requests: _voice, ...missing } = limits;
    expect(checkSettingValue(d.guest_limits, missing, context)).toMatchObject({
      ok: false,
      issues: [{ path: "value.voice_requests" }],
    });
    expect(accepts(d.guest_limits, { ...limits, window: 3600 })).toBe(false);
    expect(accepts(d.guest_limits, { ...limits, photo_recognitions: -1 })).toBe(false);
    expect(
      accepts(d.rating_weights, { reviews: 0.5, response_rate: 0.3, deadline_rate: 0.2 }),
    ).toBe(true);
    expect(
      accepts(d.rating_weights, { reviews: 0.5, response_rate: 0.5, deadline_rate: 0.5 }),
    ).toBe(false);
    expect(accepts(d.critical_notification_kinds, ["order_accepted"])).toBe(true);
    expect(accepts(d.critical_notification_kinds, [])).toBe(true);
    expect(accepts(d.critical_notification_kinds, ["unknown_kind"])).toBe(false);
  });

  it("accepts only MAJOR.MINOR.PATCH versions", () => {
    for (const value of ["1.4.0", "0.0.0", "10.20.30"]) {
      expect(accepts(d.client_min_version_android, value), value).toBe(true);
    }
    for (const value of ["1.4", "latest", "v1.4.0", " 1.4.0", "1.4.0-beta", "", 1]) {
      expect(accepts(d.client_min_version_android, value), String(value)).toBe(false);
    }
  });

  it("never lets the admin panel minimum go above its current release", () => {
    expect(accepts(d.client_min_version_admin_web, "1.2.0")).toBe(true);
    expect(accepts(d.client_min_version_admin_web, "1.1.9")).toBe(true);
    const above = checkSettingValue(d.client_min_version_admin_web, "1.2.1", context);
    expect(above).toMatchObject({ ok: false });
    expect(above.ok ? "" : above.issues[0]!.message).toContain("1.2.0");
    expect(accepts(d.client_min_version_admin_web, "garbage")).toBe(false);
    // Other platforms have no such ceiling.
    expect(accepts(d.client_min_version_ios, "99.0.0")).toBe(true);
  });
});

describe("describeConstraints", () => {
  it("describes what the admin panel needs to show and check", () => {
    expect(describeConstraints(d.supplier_response_hours, context)).toEqual({ min: 1, max: 48 });
    expect(describeConstraints(d.photo_display_mode, context)).toEqual({
      allowedValues: ["link", "copy"],
    });
    expect(describeConstraints(d.client_update_message, context)).toEqual({
      minLength: 1,
      maxLength: 500,
      languages: ["kk", "ru", "en"],
    });
    expect(describeConstraints(d.client_min_version_admin_web, context)).toEqual({
      maxVersion: "1.2.0",
    });
    expect(describeConstraints(d.client_min_version_ios, context)).toEqual({});
    const composite = describeConstraints(d.guest_limits, context).schema!;
    expect(composite).toMatchObject({
      type: "object",
      required: ["photo_recognitions", "voice_requests", "assistant_dialogs"],
      additionalProperties: false,
    });
    expect(composite).not.toHaveProperty("$schema");
  });
});
