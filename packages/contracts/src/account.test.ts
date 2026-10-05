import { describe, expect, it } from "vitest";
import { ACCOUNT_NAME_MAX_LENGTH, accountNameSchema } from "./account";

describe("accountNameSchema", () => {
  it("takes names of any script, Kazakh letters included", () => {
    for (const name of ["Марат", "Әлия Нұрғалиқызы", "Ғалым-Жан", "O’Brien", "Іңкәр Үмбетова"]) {
      expect(accountNameSchema.safeParse(name).success, name).toBe(true);
    }
  });

  it("takes a letter written as a base letter and a combining mark, and keeps it composed", () => {
    // «й» typed as «и» + U+0306, «ё» as «е» + U+0308: what pasted text often is.
    const decomposed = "Сергей Фёдоров";
    const parsed = accountNameSchema.safeParse(decomposed);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toBe("Сергей Фёдоров");
    // A mark with no precomposed form still passes after its letter.
    expect(accountNameSchema.safeParse("Ж́анна").success).toBe(true);
  });

  it("refuses what is not a name", () => {
    for (const name of [
      "",
      "   ",
      "̆Марат",
      "Марат2",
      "Марат 🙂",
      "Марат\nБ",
      "Марат\tБ",
      "-Марат",
      "М".repeat(ACCOUNT_NAME_MAX_LENGTH + 1),
    ]) {
      expect(accountNameSchema.safeParse(name).success, JSON.stringify(name)).toBe(false);
    }
  });

  it("trims the edges", () => {
    expect(accountNameSchema.parse("  Марат Б  ")).toBe("Марат Б");
  });
});
