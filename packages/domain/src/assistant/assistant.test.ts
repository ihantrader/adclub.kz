import { describe, expect, it } from "vitest";
import { claimsDiagnosis, cleanAssistantText, normalizeAssistantMessage } from "./assistant-text";
import { mileageInText } from "./mileage-in-text";

describe("mileageInText", () => {
  it.each([
    ["ТО-2, пробег 20 000", 20_000],
    ["пробег 20000", 20_000],
    ["Пробег: 45 200 км", 45_200],
    ["у меня 20к", 20_000],
    ["20 к пробег", 20_000],
    ["20 тыс км", 20_000],
    ["20 тысяч", 20_000],
    ["пробегом 1.5к", 1_500],
    ["жүрісі 20 мың", 20_000],
    ["ТО керек, 20 мың шақырым", 20_000],
    ["mileage 20k", 20_000],
    ["need service at 45,200 km? no — 45200km", 45_200],
    ["пробег 20.000", 20_000],
    ["нужно ТО на 20к, пробег 18 500", 18_500],
    ["пробег\u00a020\u00a0000", 20_000],
  ])("%s → %d", (text, km) => {
    expect(mileageInText(text)).toBe(km);
  });

  it.each([
    "Нужно ТО-2",
    "Нужно масло 4 л",
    "Масло 5W-30",
    "Geely Coolray 2024",
    "скрипит при торможении",
    "пробег большой",
    "20 канистр",
    "2 канистры по 4 л",
    "пробег 99999999",
    "",
  ])("%s → null", (text) => {
    expect(mileageInText(text)).toBeNull();
  });
});

describe("cleanAssistantText", () => {
  it("keeps plain text as it is", () => {
    expect(cleanAssistantText("Подойдёт масло 5W-30. Выберите объём.")).toEqual({
      text: "Подойдёт масло 5W-30. Выберите объём.",
      droppedSentences: 0,
      markupRemoved: false,
    });
  });

  it("drops a sentence with a phone, a link, a handle or an e-mail, whole", () => {
    const cleaned = cleanAssistantText(
      "Вот колодки. Звоните +7 705 555 01 01. Или пишите shop@mail.kz! Сайт: example.kz. Пишите @shop_kz. Подходят под Atlas.",
    );
    expect(cleaned.text).toBe("Вот колодки. Подходят под Atlas.");
    expect(cleaned.droppedSentences).toBe(4);
  });

  it("takes off HTML, markdown links and marks", () => {
    const cleaned = cleanAssistantText(
      "## Масло\n**Shell** <b>Helix</b> — [смотреть](https://evil.example) ![x](https://x.example/a.png)\n- 4 л\n* 1 л",
    );
    expect(cleaned.text).toBe("Масло\nShell Helix — смотреть\n• 4 л\n• 1 л");
    expect(cleaned.markupRemoved).toBe(true);
    expect(cleaned.text).not.toContain("http");
  });

  it("drops control characters and cuts a long text", () => {
    const cleaned = cleanAssistantText(`a\u0007b\u200bc ${"x".repeat(3000)}`, 20);
    expect(cleaned.text.startsWith("abc ")).toBe(true);
    expect(cleaned.text.length).toBe(20);
    expect(cleaned.text.endsWith("…")).toBe(true);
  });
});

describe("claimsDiagnosis", () => {
  it.each([
    "Ваш диагноз — износ колодок",
    "У вас неисправен суппорт",
    "Причина точно в колодках",
    "Бұл нақты ақау тежегіште",
    "My diagnosis: worn pads",
    "The cause is definitely the pads",
  ])("%s", (text) => {
    expect(claimsDiagnosis(text)).toBe(true);
  });

  it.each([
    "Возможные варианты: колодки и диски",
    "Рекомендуем компьютерную диагностику",
    "Engine computer diagnostics is available",
    "Компьютерлік диагностика",
  ])("not: %s", (text) => {
    expect(claimsDiagnosis(text)).toBe(false);
  });
});

describe("normalizeAssistantMessage", () => {
  it("flattens spaces and drops control characters, keeps emoji", () => {
    expect(normalizeAssistantMessage("  Нужно\n\tмасло\u0007 🙂 \u200b ")).toBe("Нужно масло 🙂");
  });

  it("is empty for nothing but spaces and controls", () => {
    expect(normalizeAssistantMessage(" \u0000\n\u200b ")).toBe("");
  });

  it("keeps at most 1000 characters", () => {
    expect([...normalizeAssistantMessage("я".repeat(1200))]).toHaveLength(1000);
  });
});
