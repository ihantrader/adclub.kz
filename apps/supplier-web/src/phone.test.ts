import { normalizeKzMobilePhone } from "@adclub/domain";
import { describe, expect, it } from "vitest";
import { formatPhone, typePhone } from "./phone";

describe("phone numbers", () => {
  it("shows a colleague's number grouped", () => {
    expect(formatPhone("+77055550101")).toBe("+7 705 555 01 01");
    expect(formatPhone("+1 555")).toBe("+1 555");
  });

  it("groups the digits while typing and keeps +7 in front", () => {
    expect(typePhone("")).toBe("+7");
    expect(typePhone("+7 ")).toBe("+7");
    expect(typePhone("705")).toBe("+7 705");
    expect(typePhone("87055550101")).toBe("+7 705 555 01 01");
    expect(typePhone("+7 (705) 555-01-01 99")).toBe("+7 705 555 01 01");
    expect(normalizeKzMobilePhone(typePhone("87055550101"))).toBe("+77055550101");
  });
});
