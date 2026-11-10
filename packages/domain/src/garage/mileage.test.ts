import { describe, expect, it } from "vitest";
import {
  isMileageInRange,
  MILEAGE_MAX_KM,
  mileageVerdict,
  milesToKm,
  parseMileageInput,
} from "./mileage";

describe("mileageVerdict", () => {
  it("takes the first reading of a car", () => {
    expect(mileageVerdict(45_200, null)).toEqual({ ok: true, change: "new" });
    expect(mileageVerdict(0, null)).toEqual({ ok: true, change: "new" });
    expect(mileageVerdict(MILEAGE_MAX_KM, null)).toEqual({ ok: true, change: "new" });
  });

  it("refuses what is not a whole number within the range", () => {
    for (const value of [-1, MILEAGE_MAX_KM + 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(mileageVerdict(value, null)).toEqual({ ok: false, reason: "range" });
      expect(isMileageInRange(value)).toBe(false);
    }
  });

  it("takes a higher reading", () => {
    expect(mileageVerdict(45_201, 45_200)).toEqual({ ok: true, change: "new" });
  });

  it("writes nothing for the same reading", () => {
    expect(mileageVerdict(45_200, 45_200)).toEqual({ ok: true, change: "same" });
    expect(mileageVerdict(45_200, 45_200, true)).toEqual({ ok: true, change: "same" });
  });

  it("asks about a lower reading and takes it once confirmed", () => {
    expect(mileageVerdict(30_000, 45_200)).toEqual({ ok: false, reason: "lower", lastKm: 45_200 });
    expect(mileageVerdict(30_000, 45_200, true)).toEqual({ ok: true, change: "new" });
  });

  it("checks the range before anything else", () => {
    expect(mileageVerdict(-5, 45_200, true)).toEqual({ ok: false, reason: "range" });
  });
});

describe("milesToKm", () => {
  it("rounds to a whole kilometre", () => {
    expect(milesToKm(28_087)).toBe(45_202);
    expect(milesToKm(0)).toBe(0);
    expect(milesToKm(1)).toBe(2);
  });
});

describe("parseMileageInput", () => {
  it("reads digits with thousands separators", () => {
    expect(parseMileageInput("45 200")).toBe(45_200);
    expect(parseMileageInput("45\u00a0200")).toBe(45_200);
    expect(parseMileageInput("45200")).toBe(45_200);
    expect(parseMileageInput(" 7 ")).toBe(7);
  });

  it("gives null for anything else", () => {
    expect(parseMileageInput("")).toBeNull();
    expect(parseMileageInput("45 км")).toBeNull();
    expect(parseMileageInput("-3")).toBeNull();
    expect(parseMileageInput("45.5")).toBeNull();
    expect(parseMileageInput("45,5")).toBeNull();
    expect(parseMileageInput("1234567890")).toBeNull();
  });
});
