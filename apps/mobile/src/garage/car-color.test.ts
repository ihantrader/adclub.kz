import { describe, expect, it } from "vitest";
import { CAR_COLOR_IDS } from "@adclub/contracts";
import { CAR_COLORS, findCarColor, isCarColorId } from "./car-color";

describe("the fixed list of car colours (D-063)", () => {
  it("has between 10 and 14 colours, as the task asks", () => {
    expect(CAR_COLORS.length).toBeGreaterThanOrEqual(10);
    expect(CAR_COLORS.length).toBeLessThanOrEqual(14);
  });

  it("lists exactly the colours the contract (and so the server) accepts", () => {
    expect(CAR_COLORS.map((option) => option.id)).toEqual([...CAR_COLOR_IDS]);
  });

  it("has no two colours with the same id", () => {
    const ids = CAR_COLORS.map((option) => option.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every colour a swatch that looks like a colour, not a design token", () => {
    for (const option of CAR_COLORS) {
      expect(option.swatch).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it("finds a known colour and says `null` has none", () => {
    expect(findCarColor(null)).toBeNull();
    expect(findCarColor("blue")?.id).toBe("blue");
  });

  it("recognises only today's ids, so a value the app no longer lists is not read as one", () => {
    expect(isCarColorId("blue")).toBe(true);
    expect(isCarColorId("chartreuse")).toBe(false);
    expect(isCarColorId(null)).toBe(false);
    expect(isCarColorId(42)).toBe(false);
  });
});
