import type { Setting } from "@adclub/contracts";
import { describe, expect, it } from "vitest";
import {
  editorOf,
  formatValue,
  inputOf,
  parseInput,
  rangeText,
  readOnly,
  reasonProblem,
  sameValue,
  settingActorText,
} from "./setting-rules";

function setting(overrides: Partial<Setting>): Setting {
  return {
    key: "supplier_response_hours",
    group: "orders",
    type: "duration",
    unit: "hours",
    description: "Сколько часов поставщик может не отвечать",
    constraints: { min: 1, max: 48 },
    defaultValue: 2,
    value: 2,
    isDefault: true,
    storedValueInvalid: false,
    version: 0,
    editableBy: "admin",
    lastChange: null,
    ...overrides,
  };
}

describe("a setting's field and value", () => {
  it("edits a duration as a whole number within its range, before anything is sent", () => {
    const hours = setting({});
    expect(editorOf(hours)).toBe("integer");
    expect(rangeText(hours)).toBe("от 1 до 48 ч");
    expect(formatValue(hours, 24)).toBe("24 ч");
    expect(parseInput(hours, " 4 ")).toEqual({ ok: true, value: 4 });
    expect(parseInput(hours, "49")).toEqual({ ok: false, error: "Допустимо от 1 до 48 ч" });
    expect(parseInput(hours, "0")).toMatchObject({ ok: false });
    expect(parseInput(hours, "2.5")).toEqual({ ok: false, error: "Введите целое число" });
    expect(parseInput(hours, "")).toEqual({ ok: false, error: "Введите число" });
    expect(parseInput(hours, "два")).toEqual({ ok: false, error: "Введите число" });
  });

  it("takes a fraction with a comma, and money with its sign", () => {
    const ratio = setting({ type: "number", unit: "ratio", constraints: { min: 0, max: 1 } });
    expect(parseInput(ratio, "0,25")).toEqual({ ok: true, value: 0.25 });
    const budget = setting({ type: "number", unit: "usd", constraints: { min: 0, max: 1000 } });
    expect(formatValue(budget, 1.5)).toBe("$1,5");
  });

  it("edits a flag, a list and a version", () => {
    const flag = setting({ type: "boolean", unit: null, constraints: {}, value: true });
    expect(inputOf(flag)).toBe(true);
    expect(formatValue(flag, false)).toBe("Нет");
    expect(parseInput(flag, false)).toEqual({ ok: true, value: false });

    const mode = setting({
      type: "enum",
      unit: null,
      constraints: { allowedValues: ["copy", "link"] },
      value: "link",
    });
    expect(parseInput(mode, "copy")).toEqual({ ok: true, value: "copy" });
    expect(parseInput(mode, "both")).toMatchObject({ ok: false });

    const admin = setting({
      type: "app_version",
      unit: null,
      constraints: { maxVersion: "0.1.0" },
      value: "0.0.0",
    });
    expect(parseInput(admin, "0.1.0")).toEqual({ ok: true, value: "0.1.0" });
    expect(parseInput(admin, "0.2.0")).toEqual({
      ok: false,
      error: "Нельзя установить минимальную версию админки выше текущей версии (0.1.0)",
    });
    expect(parseInput(admin, "1.4")).toEqual({ ok: false, error: "Версия — три числа: 1.4.0" });
  });

  it("edits a text in three languages, each one required", () => {
    const message = setting({
      type: "localized_text",
      unit: null,
      constraints: { languages: ["kk", "ru", "en"], maxLength: 300 },
      value: { kk: "Жаңартыңыз", ru: "Обновите", en: "Update" },
    });
    const input = inputOf(message);
    expect(input).toEqual({ kk: "Жаңартыңыз", ru: "Обновите", en: "Update" });
    expect(formatValue(message, message.value)).toBe("Обновите");
    expect(parseInput(message, { kk: " Жаңарт ", ru: "Обновите", en: "Update" })).toEqual({
      ok: true,
      value: { kk: "Жаңарт", ru: "Обновите", en: "Update" },
    });
    expect(parseInput(message, { kk: "", ru: "Обновите", en: "Update" })).toEqual({
      ok: false,
      error: "Заполните текст на всех языках: kk",
    });
    expect(parseInput(message, { kk: "к".repeat(301), ru: "р", en: "e" })).toMatchObject({
      ok: false,
    });
  });

  it("edits a composite value as JSON and says when the text isn't JSON", () => {
    const weights = setting({
      type: "composite",
      unit: null,
      constraints: { schema: {} },
      value: { price: 1, receipt: 0 },
    });
    expect(editorOf(weights)).toBe("json");
    expect(parseInput(weights, '{"price":1,"receipt":0.5}')).toEqual({
      ok: true,
      value: { price: 1, receipt: 0.5 },
    });
    expect(parseInput(weights, "{price:1")).toMatchObject({ ok: false });
    expect(sameValue({ price: 1, receipt: 0 }, { receipt: 0, price: 1 })).toBe(true);
    expect(sameValue({ price: 1 }, { price: 2 })).toBe(false);
  });

  it("requires a reason that isn't blank", () => {
    expect(reasonProblem("   ")).not.toBeNull();
    expect(reasonProblem(" ок ")).not.toBeNull();
    expect(reasonProblem("Сбой канала")).toBeNull();
    expect(reasonProblem("x".repeat(501))).not.toBeNull();
  });

  it("shows the sign-in security settings read-only and says who changed a value", () => {
    expect(readOnly(setting({ editableBy: "operator" }))).toBe(true);
    expect(readOnly(setting({}))).toBe(false);
    expect(settingActorText({ kind: "operator" })).toBe("оператор сервера");
    expect(
      settingActorText({
        kind: "admin",
        adminId: "00000000-0000-4000-8000-000000000001",
        phoneMasked: "+7***4567",
      }),
    ).toBe("+7***4567");
  });
});
