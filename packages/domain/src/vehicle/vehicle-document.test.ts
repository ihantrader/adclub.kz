import { describe, expect, it } from "vitest";
import {
  checkVin,
  engineMatchesVolume,
  engineVolumeCc,
  formatKzPlate,
  maskKzPlate,
  maskVin,
  normalizeKzPlate,
  normalizeVin,
} from "./vehicle-document";

describe("VIN (T-GAR-07)", () => {
  it("takes 17 characters without I, O and Q, in upper case and without separators", () => {
    expect(checkVin("LB37624S9NX123456")).toEqual({ ok: true, vin: "LB37624S9NX123456" });
    expect(checkVin(" lb3 7624-s9nx 123456 ")).toEqual({ ok: true, vin: "LB37624S9NX123456" });
  });

  it("does not need the check digit (Chinese makes don't follow it)", () => {
    // The 9th character of a valid ISO 3779 VIN would be computed; here it is just a digit.
    expect(normalizeVin("L6T7824Z1NN000001")).toBe("L6T7824Z1NN000001");
  });

  it("reads Cyrillic letters that look like Latin ones as Latin", () => {
    expect(normalizeVin("ХТА21099071234567")).toBe("XTA21099071234567");
  });

  it("refuses I, O and Q instead of guessing a digit", () => {
    expect(checkVin("LB37624S9NXO23456")).toEqual({ ok: false, reason: "characters" });
    expect(checkVin("IB37624S9NX123456")).toEqual({ ok: false, reason: "characters" });
    expect(checkVin("LB37624S9NX12345Q")).toEqual({ ok: false, reason: "characters" });
    expect(checkVin("LB37624S9NX12345*")).toEqual({ ok: false, reason: "characters" });
  });

  it("refuses a wrong length, and an empty or missing text is no VIN", () => {
    expect(checkVin("LB37624S9NX12345")).toEqual({ ok: false, reason: "length" });
    expect(checkVin("LB37624S9NX1234567")).toEqual({ ok: false, reason: "length" });
    expect(normalizeVin("")).toBeNull();
    expect(normalizeVin(null)).toBeNull();
    expect(normalizeVin(undefined)).toBeNull();
  });

  it("is masked to the maker's code and the last four characters", () => {
    expect(maskVin("LB37624S9NX123456")).toBe("LB3**********3456");
    expect(maskVin("short")).toBe("***");
  });
});

describe("Kazakhstan plate", () => {
  it("takes the current plate in any writing and keeps it compact", () => {
    expect(normalizeKzPlate("123 ABC 02")).toBe("123ABC02");
    expect(normalizeKzPlate("123abc02")).toBe("123ABC02");
    expect(normalizeKzPlate("123-AB-17")).toBe("123AB17");
    expect(normalizeKzPlate("777 КМА 01")).toBe("777KMA01");
  });

  it("takes the older plate with the region letter first", () => {
    expect(normalizeKzPlate("A 123 BCD")).toBe("A123BCD");
    expect(formatKzPlate("A123BCD")).toBe("A 123 BCD");
  });

  it("refuses what is not a Kazakhstan plate", () => {
    expect(normalizeKzPlate("А123ВС77")).toBeNull(); // a Russian plate: region 77 after letters
    expect(normalizeKzPlate("123ABC21")).toBeNull(); // no region 21
    expect(normalizeKzPlate("123ABC00")).toBeNull();
    expect(normalizeKzPlate("12ABC02")).toBeNull();
    expect(normalizeKzPlate("123ABCD02")).toBeNull();
    expect(normalizeKzPlate("")).toBeNull();
    expect(normalizeKzPlate(null)).toBeNull();
  });

  it("is shown as on the plate", () => {
    expect(formatKzPlate("123ABC02")).toBe("123 ABC 02");
    expect(formatKzPlate("123AB17")).toBe("123 AB 17");
  });

  it("is masked to its region", () => {
    expect(maskKzPlate("123ABC02")).toBe("*** *** 02");
    expect(maskKzPlate("A123BCD")).toBe("A *** ***");
    expect(maskKzPlate("nonsense")).toBe("***");
  });
});

describe("engine size", () => {
  it("reads cm³ and litres", () => {
    expect(engineVolumeCc(1477)).toBe(1477);
    expect(engineVolumeCc("1 477 см³")).toBe(1477);
    expect(engineVolumeCc("1.5")).toBe(1500);
    expect(engineVolumeCc("1,5 л")).toBe(1500);
  });

  it("is no size when it can't be one", () => {
    expect(engineVolumeCc(0)).toBeNull();
    expect(engineVolumeCc(12)).toBeNull();
    expect(engineVolumeCc("—")).toBeNull();
    expect(engineVolumeCc(null)).toBeNull();
    expect(engineVolumeCc(25000)).toBeNull();
  });

  it("matches the catalog's tenth of a litre", () => {
    expect(engineMatchesVolume(1.5, 1477)).toBe(true);
    expect(engineMatchesVolume(1.5, 1498)).toBe(true);
    expect(engineMatchesVolume(2.0, 1969)).toBe(true);
    expect(engineMatchesVolume(1.8, 1477)).toBe(false);
  });
});
