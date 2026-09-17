import { describe, expect, it } from "vitest";
import { maskPhone, normalizeKzMobilePhone } from "./kz-mobile-phone";

const NO_BREAK_SPACE = String.fromCharCode(0xa0);

describe("normalizeKzMobilePhone", () => {
  it.each([
    "+77011234567",
    "+7 701 123 45 67",
    "+7 (701) 123-45-67",
    "8 701 123 45 67",
    "8(701)1234567",
    "87011234567",
    "77011234567",
    "7011234567",
    " +7 701 123 45 67 ",
    "+7.701.123.45.67",
    ["+7", "701", "1234567"].join(NO_BREAK_SPACE),
  ])("brings %j to one E.164 number", (input) => {
    expect(normalizeKzMobilePhone(input)).toBe("+77011234567");
  });

  it.each(["+77001234567", "+77051234567", "+77471234567", "+77711234567", "+77781234567"])(
    "accepts the mobile operator range of %s",
    (input) => {
      expect(normalizeKzMobilePhone(input)).toBe(input);
    },
  );

  it.each([
    ["empty", ""],
    ["letters", "abc"],
    ["letters inside", "+7 701 12a 45 67"],
    ["too short", "+7701123456"],
    ["too long", "+770112345678"],
    ["Russian mobile", "+79161234567"],
    ["Russian mobile with 8", "89161234567"],
    ["Almaty landline", "+77272123456"],
    ["Astana landline", "+77172123456"],
    ["another country", "+998901234567"],
    ["plus eight", "+87011234567"],
    ["double plus", "++77011234567"],
    ["very long garbage", "7".repeat(500)],
    ["unicode digits", "+٧٧٠١١٢٣٤٥٦٧"],
  ])("rejects %s", (_label, input) => {
    expect(normalizeKzMobilePhone(input)).toBeNull();
  });
});

describe("maskPhone", () => {
  it("keeps only the country code and the last four digits", () => {
    expect(maskPhone("+77011234567")).toBe("+7***4567");
  });

  it("never returns the full number of a short value", () => {
    expect(maskPhone("12345")).toBe("***");
  });
});
