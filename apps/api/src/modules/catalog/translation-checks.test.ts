import { catalogNameText, translationMaxLengths } from "@adclub/contracts";
import { describe, expect, it } from "vitest";
import { checkTranslation, maxLengthOf } from "./translation-checks";

// A raw control character, written as an escape so the source stays plain text.
const BELL = String.fromCharCode(7);

describe("checks of an automatic translation (TASK-012)", () => {
  it("accepts a good translation and brings it to one form", () => {
    expect(checkTranslation("Тежегіш  қалыптары", "kk", "Тормозные колодки", 40)).toEqual({
      ok: true,
      text: "Тежегіш қалыптары",
    });
    expect(checkTranslation(" Brake pads ", "en", "Тормозные колодки", 40)).toEqual({
      ok: true,
      text: "Brake pads",
    });
    // NFC: a decomposed letter is the same letter.
    const decomposed = String.fromCharCode(0x0418, 0x0306);
    expect(checkTranslation(`${decomposed}ол`, "kk", "Путь", 40)).toEqual({
      ok: true,
      text: "Йол",
    });
  });

  it("refuses an empty text, a text of only spaces and a missing one", () => {
    expect(checkTranslation("", "en", "Колодки", 40)).toEqual({ ok: false, failure: "empty" });
    expect(checkTranslation("   ", "kk", "Колодки", 40)).toEqual({ ok: false, failure: "empty" });
  });

  it("refuses a text longer than the field allows, by the same limit as writing it by hand", () => {
    expect(checkTranslation("x".repeat(40), "en", "Колодки", 40).ok).toBe(true);
    expect(checkTranslation("x".repeat(41), "en", "Колодки", 40)).toEqual({
      ok: false,
      failure: "too_long",
    });
    expect(maxLengthOf("category", "name")).toBe(40);
    expect(maxLengthOf("attribute", "unit")).toBe(12);
    expect(maxLengthOf("catalog_item", "name")).toBe(200);
    expect(() => maxLengthOf("category", "unit")).toThrow(/no translatable field/);
  });

  it("refuses control characters anywhere, including inside the text", () => {
    expect(checkTranslation(`Brake${BELL}pads`, "en", "Колодки", 40)).toEqual({
      ok: false,
      failure: "control_characters",
    });
    expect(checkTranslation("Brake\npads", "en", "Колодки", 40)).toEqual({
      ok: false,
      failure: "control_characters",
    });
  });

  it("refuses English that is still Russian and Kazakh that is only Latin for a Russian source", () => {
    expect(checkTranslation("Тормозные колодки", "en", "Тормозные колодки", 40)).toEqual({
      ok: false,
      failure: "wrong_language",
    });
    expect(checkTranslation("Brake pads", "kk", "Тормозные колодки", 40)).toEqual({
      ok: false,
      failure: "wrong_language",
    });
    // A source with no Cyrillic (a brand, a viscosity) may stay as it is.
    expect(checkTranslation("5W-30", "kk", "5W-30", 40)).toEqual({ ok: true, text: "5W-30" });
    expect(checkTranslation("Shell", "en", "Shell", 40)).toEqual({ ok: true, text: "Shell" });
  });

  it("is the check of writing a name by hand: the same schema, so the two can't drift apart", () => {
    const samples = ["", " ", "a", "x".repeat(41), `a${BELL}b`, "a\tb", " a ", "Қазақша"];
    for (const [entityType, fields] of Object.entries(translationMaxLengths)) {
      for (const field of Object.keys(fields)) {
        const max = maxLengthOf(entityType as "category", field as "name");
        for (const sample of samples) {
          const byHand = catalogNameText(max).safeParse(sample).success;
          // Kazakh for a source without Cyrillic: only the shared checks decide.
          const automatic = checkTranslation(sample, "kk", "5W-30", max).ok;
          expect(automatic, `${entityType}.${field} ${JSON.stringify(sample)}`).toBe(byHand);
        }
      }
    }
  });
});
