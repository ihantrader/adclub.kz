import { describe, expect, it } from "vitest";
import { phoneSearchDigits } from "./phone-search";

describe("phoneSearchDigits", () => {
  it("takes a part of a number in any spelling", () => {
    expect(phoneSearchDigits("+7 701 123")).toEqual(["7701123"]);
    expect(phoneSearchDigits("701-12")).toEqual(["70112"]);
    expect(phoneSearchDigits(" 4567 ")).toEqual(["4567"]);
    expect(phoneSearchDigits("1028")).toEqual(["1028"]);
  });

  it("reads the trunk prefix 8 as +7", () => {
    expect(phoneSearchDigits("8 701 123 45 67")).toEqual(["87011234567", "77011234567"]);
    expect(phoneSearchDigits("8 (701) 12")).toEqual(["870112", "770112"]);
    // A part that merely starts with 8 is searched as typed.
    expect(phoneSearchDigits("845")).toEqual(["845"]);
  });

  it("is no phone with letters, too few or too many digits", () => {
    expect(phoneSearchDigits("Айгерим")).toBeNull();
    expect(phoneSearchDigits("04465-0K090")).toBeNull();
    expect(phoneSearchDigits("12")).toBeNull();
    expect(phoneSearchDigits("№ 1028")).toBeNull();
    expect(phoneSearchDigits("123456789012")).toBeNull();
  });
});
