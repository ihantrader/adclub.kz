import { describe, expect, it } from "vitest";
import { checkKzBin, kzBinCheckDigit, maskBin } from "./kz-bin";

/** Builds a valid number from 11 digits (or `null` when none exists). */
function complete(first11: string): string | null {
  const digit = kzBinCheckDigit(first11);
  return digit === null ? null : `${first11}${digit}`;
}

describe("Kazakhstan БИН/ИИН", () => {
  it("accepts a number whose check digit matches (first pass)", () => {
    // 1·0+2·8+3·0+4·7+5·4+6·0+7·0+8·0+9·0+10·1+11·2 = 96; 96 mod 11 = 8.
    expect(kzBinCheckDigit("08074000012")).toBe(8);
    expect(checkKzBin("080740000128")).toEqual({ ok: true, bin: "080740000128" });
  });

  it("takes the second weights when the first remainder is 10", () => {
    const prefix = "00000000019"; // 10·1 + 11·9 = 109; 109 mod 11 = 10.
    expect(109 % 11).toBe(10);
    // Second pass: 1·1 + 2·9 = 19; 19 mod 11 = 8.
    expect(kzBinCheckDigit(prefix)).toBe(8);
    expect(checkKzBin(`${prefix}8`).ok).toBe(true);
    expect(checkKzBin(`${prefix}0`)).toEqual({ ok: false, reason: "checksum" });
  });

  it("refuses 11 digits no check digit exists for", () => {
    // Both passes give 10: no valid number starts with these digits.
    let found: string | undefined;
    for (let n = 0; n < 100_000 && !found; n++) {
      const prefix = String(n).padStart(11, "0");
      if (kzBinCheckDigit(prefix) === null) {
        found = prefix;
      }
    }
    expect(found).toBeDefined();
    for (let digit = 0; digit <= 9; digit++) {
      expect(checkKzBin(`${found}${digit}`)).toEqual({ ok: false, reason: "checksum" });
    }
  });

  it("refuses a wrong check digit and a wrong form", () => {
    const valid = complete("99084000123")!;
    const wrong = `${valid.slice(0, 11)}${(Number(valid[11]) + 1) % 10}`;
    expect(checkKzBin(valid).ok).toBe(true);
    expect(checkKzBin(wrong)).toEqual({ ok: false, reason: "checksum" });
    expect(checkKzBin("12345")).toEqual({ ok: false, reason: "format" });
    expect(checkKzBin("0807400001281")).toEqual({ ok: false, reason: "format" });
    expect(checkKzBin("08074000012a")).toEqual({ ok: false, reason: "format" });
    expect(checkKzBin("")).toEqual({ ok: false, reason: "format" });
  });

  it("ignores spaces and dashes people type", () => {
    expect(checkKzBin(" 0807 4000 0128 ")).toEqual({ ok: true, bin: "080740000128" });
    expect(checkKzBin("080740-000128")).toEqual({ ok: true, bin: "080740000128" });
  });

  it("masks all but the last four digits", () => {
    expect(maskBin("080740000128")).toBe("********0128");
    expect(maskBin("12")).toBe("****");
  });
});
