import { describe, expect, it } from "vitest";
import {
  formatKzPhone,
  KZ_PHONE_PLACEHOLDER,
  kzPhoneDigits,
  maskKzPhoneInput,
} from "./format-phone";

describe("formatKzPhone — a number as people read it (TASK-078 M4)", () => {
  it.each([
    ["+77010000380", "+7 701 000 03 80"],
    ["87011234567", "+7 701 123 45 67"],
    ["+7 (701) 123-45-67", "+7 701 123 45 67"],
    ["7011234567", "+7 701 123 45 67"],
    ["+77055550101", "+7 705 555 01 01"],
  ])("writes %s as %s", (input, shown) => {
    expect(formatKzPhone(input)).toBe(shown);
  });

  it("leaves an incomplete number as it came", () => {
    expect(formatKzPhone("+7 701 12")).toBe("+7 701 12");
    expect(formatKzPhone(" +7701 ")).toBe("+7701");
  });

  it("leaves a number of another country, and a landline, untouched", () => {
    expect(formatKzPhone("+998901234567")).toBe("+998901234567");
    expect(formatKzPhone("+7 727 212 34 56")).toBe("+7 727 212 34 56");
    expect(formatKzPhone("")).toBe("");
  });
});

describe("maskKzPhoneInput — the field «+7 7__ ___ __ __» (M-AUTH-01)", () => {
  it("has the country code as its placeholder", () => {
    expect(KZ_PHONE_PLACEHOLDER).toBe("+7 7__ ___ __ __");
  });

  it("groups the digits as they are typed", () => {
    expect(maskKzPhoneInput("")).toBe("+7 ");
    expect(maskKzPhoneInput("+7 ")).toBe("+7 ");
    expect(maskKzPhoneInput("+7 7")).toBe("+7 7");
    expect(maskKzPhoneInput("+7 701")).toBe("+7 701");
    expect(maskKzPhoneInput("+7 7011")).toBe("+7 701 1");
    expect(maskKzPhoneInput("+7 701 1234")).toBe("+7 701 123 4");
    expect(maskKzPhoneInput("+7 701 123 456")).toBe("+7 701 123 45 6");
    expect(maskKzPhoneInput("+7 701 123 4567")).toBe("+7 701 123 45 67");
  });

  it("takes a pasted number in any writing", () => {
    expect(maskKzPhoneInput("87011234567")).toBe("+7 701 123 45 67");
    expect(maskKzPhoneInput("77011234567")).toBe("+7 701 123 45 67");
    expect(maskKzPhoneInput("+7 (701) 123-45-67")).toBe("+7 701 123 45 67");
    expect(maskKzPhoneInput("7011234567")).toBe("+7 701 123 45 67");
  });

  it("never takes more than ten national digits", () => {
    expect(maskKzPhoneInput("+7 701 123 45 678")).toBe("+7 701 123 45 67");
    expect(maskKzPhoneInput("+7 701 123 45 67 89")).toBe("+7 701 123 45 67");
  });

  it("deletes the digit before a separator when the separator is deleted", () => {
    // Backspace over the space after «701» removes the space only; the digit goes with it.
    expect(maskKzPhoneInput("+7 7011", "+7 701 1")).toBe("+7 701");
    expect(maskKzPhoneInput("+7 701123", "+7 701 123")).toBe("+7 701 12");
    // An ordinary backspace over a digit is just that.
    expect(maskKzPhoneInput("+7 701 12", "+7 701 123")).toBe("+7 701 12");
  });

  it("does not turn a number of another country into a Kazakhstan one by itself", () => {
    // The field is for +7 numbers: the digits are kept, and the validation
    // («Введите мобильный номер Казахстана») says what is wrong.
    expect(kzPhoneDigits("+998 90 123 45 67")).toBe("9989012345");
    expect(maskKzPhoneInput("+998 90 123 45 67")).toBe("+7 998 901 23 45");
  });

  it("keeps the country code when everything is deleted", () => {
    expect(maskKzPhoneInput("+", "+7 ")).toBe("+7 ");
    expect(maskKzPhoneInput("+7", "+7 7")).toBe("+7 ");
  });
});
