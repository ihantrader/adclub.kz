import { describe, expect, it } from "vitest";
import { languages, locales, pickLanguage, translate } from "./translate";

describe("translate", () => {
  it("has all three required languages", () => {
    expect([...languages].sort()).toEqual(["en", "kk", "ru"]);
  });

  it("returns the demo key in every language", () => {
    expect(translate("ru", "common.appWorking")).toBe("Работает");
    expect(translate("kk", "common.appWorking")).toBe("Жұмыс істеп тұр");
    expect(translate("en", "common.appWorking")).toBe("Working");
  });

  it("has the same, non-empty keys in every language", () => {
    const reference = Object.keys(locales.ru).sort();
    for (const lang of languages) {
      expect(Object.keys(locales[lang]).sort()).toEqual(reference);
      for (const value of Object.values(locales[lang])) {
        expect(value.trim()).not.toBe("");
      }
    }
  });
});

describe("pickLanguage", () => {
  it("falls back to Russian without a header", () => {
    expect(pickLanguage(undefined)).toBe("ru");
    expect(pickLanguage("")).toBe("ru");
  });

  it("maps region subtags to the base language", () => {
    expect(pickLanguage("kk-KZ")).toBe("kk");
    expect(pickLanguage("EN-us")).toBe("en");
  });

  it("honours q weights over order", () => {
    expect(pickLanguage("ru;q=0.5, en;q=0.9")).toBe("en");
    expect(pickLanguage("de, kk;q=0.1, en;q=0.2")).toBe("en");
  });

  it("skips unsupported and zero-weighted languages", () => {
    expect(pickLanguage("de-DE, fr;q=0.8")).toBe("ru");
    expect(pickLanguage("en;q=0, kk;q=0.3")).toBe("kk");
  });

  it("does not throw on garbage", () => {
    expect(pickLanguage(";;;,,q=abc")).toBe("ru");
    expect(pickLanguage("*")).toBe("ru");
  });
});
