import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Plain Node checks: this file must not import react-native. The catalog
// exists only for a car (D-062): there is no «Показать без фильтра» and no
// «Пропустить» on the first run, in the code, in the texts or in the tests.
// This is that grep, kept as a test so it cannot quietly come back.
const src = join(__dirname, "..");
const i18n = join(__dirname, "../../../../packages/i18n/src/mobile");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** Names a way to look at the catalog without a car, or to leave the first run without one. */
const FORBIDDEN_IN_CODE =
  /filterOff|showWithoutCar|onFilterOff|carFilterOff|catalog\.showAll|catalog\.noCar|common\.skip|hintAddCar|checkForCar/;
/** The words of the removed rows and buttons, in the three languages of the texts. */
const FORBIDDEN_TEXT = [
  /без фильтра/i,
  /Показать всё/,
  /Пропустить/,
  /Сүзгісіз көрсету/,
  /Өткізіп жіберу/,
  /Show without the filter/i,
  /\bSkip\b/,
];

describe("the catalog exists only for a car (D-062)", () => {
  it("has no way to look without one in the code", () => {
    const own = join(src, "catalog/no-catalog-without-car.test.ts");
    for (const path of sourceFiles(src)) {
      if (path === own) continue;
      expect(readFileSync(path, "utf8"), path).not.toMatch(FORBIDDEN_IN_CODE);
    }
  });

  it("has no such row and no such button in the texts of any language", () => {
    for (const lang of ["ru", "kk", "en"]) {
      const file = readFileSync(join(i18n, `${lang}.json`), "utf8");
      const texts = JSON.parse(file) as Record<string, string>;
      for (const [key, text] of Object.entries(texts)) {
        expect(key, `${lang}: ${key}`).not.toMatch(FORBIDDEN_IN_CODE);
        for (const word of FORBIDDEN_TEXT) expect(text, `${lang}: ${key}`).not.toMatch(word);
      }
    }
  });

  it("asks for a car with its own words", () => {
    const ru = JSON.parse(readFileSync(join(i18n, "ru.json"), "utf8")) as Record<string, string>;
    expect(ru["catalog.needCarTitle"]).toBe("Добавьте автомобиль");
    expect(ru["garage.add"]).toBe("Добавить автомобиль");
  });
});
