import { describe, expect, it } from "vitest";
import { localize, mergeTexts, nameKey, normalizeText, type StoredTexts } from "./catalog-texts";
import type { TranslationRow } from "./schema";

function row(lang: "kk" | "ru" | "en", text: string): TranslationRow {
  return {
    id: `${lang}-id`,
    entityType: "category",
    entityId: "c",
    field: "name",
    lang,
    text,
    origin: lang === "ru" ? "source" : "manual",
    isManuallyEdited: true,
    sourceHash: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

describe("catalog texts", () => {
  it("brings names to one form and compares them without case", () => {
    expect(normalizeText("  Тормозные \t колодки  ")).toBe("Тормозные колодки");
    // Kazakh letters decomposed and composed are the same name.
    expect(normalizeText("й")).toBe("й");
    expect(nameKey("КОЛОДКИ")).toBe(nameKey("колодки"));
    expect(nameKey("ҚАЛЫПТАР")).toBe(nameKey("қалыптар"));
    expect(nameKey("Колодки")).not.toBe(nameKey("Колодка"));
  });

  it("gives the asked language, else Russian marked as a fallback", () => {
    const texts: StoredTexts = { ru: row("ru", "Тормоза"), en: row("en", "Brakes") };
    expect(localize(texts, "en")).toEqual({ text: "Brakes", isFallback: false });
    expect(localize(texts, "kk")).toEqual({ text: "Тормоза", isFallback: true });
    expect(localize(texts, "ru")).toEqual({ text: "Тормоза", isFallback: false });
    expect(localize({}, "kk")).toBeNull();
  });

  it("merges changes: absent keeps, null clears, text replaces", () => {
    const current = { kk: "Тежегіштер", ru: "Тормоза", en: "Brakes" };
    expect(mergeTexts(current, { en: null, ru: " Тормоза  и диски " })).toEqual({
      kk: "Тежегіштер",
      ru: "Тормоза и диски",
      en: null,
    });
    expect(mergeTexts(current, undefined)).toEqual(current);
  });
});
