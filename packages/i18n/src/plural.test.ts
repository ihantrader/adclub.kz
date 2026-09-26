import { describe, expect, it } from "vitest";
import { formatText, pluralForm } from "./plural";

describe("plural forms", () => {
  it("follows the Russian rule, including the teens", () => {
    const ru = (n: number) => pluralForm("ru", n);
    expect([1, 21, 101, 131].map(ru)).toEqual(["one", "one", "one", "one"]);
    expect([2, 3, 4, 22, 104].map(ru)).toEqual(["few", "few", "few", "few", "few"]);
    expect([0, 5, 11, 12, 13, 14, 19, 25, 111].map(ru)).toEqual([
      "many",
      "many",
      "many",
      "many",
      "many",
      "many",
      "many",
      "many",
      "many",
    ]);
  });

  it("has two forms in English and one in Kazakh", () => {
    expect([1, 2, 5, 21].map((n) => pluralForm("en", n))).toEqual(["one", "many", "many", "many"]);
    expect([1, 2, 5, 21].map((n) => pluralForm("kk", n))).toEqual(["many", "many", "many", "many"]);
  });

  it("ignores the sign and the fraction", () => {
    expect(pluralForm("ru", -1)).toBe("one");
    expect(pluralForm("ru", 2.7)).toBe("few");
  });
});

describe("text substitution", () => {
  it("fills every placeholder it has a value for", () => {
    expect(formatText("Показать {n} позиций", { n: 12 })).toBe("Показать 12 позиций");
    expect(formatText("Подходит для {car}", { car: "Geely Atlas 2023" })).toBe(
      "Подходит для Geely Atlas 2023",
    );
  });

  it("leaves a placeholder without a value visible", () => {
    expect(formatText("Есть в {city}", {})).toBe("Есть в {city}");
    expect(formatText("Без подстановок")).toBe("Без подстановок");
  });
});
