import { describe, expect, it } from "vitest";
import { readAdminQuery } from "./admin-query";

describe("readAdminQuery (A-SEARCH)", () => {
  it("reads a bare number as an order's number and a part of a phone at once", () => {
    expect(readAdminQuery("1028")).toEqual({
      phoneDigits: ["1028"],
      orderNumber: 1028,
      bin: null,
      article: null,
      text: null,
    });
  });

  it("reads «№ 4821» as an order's number only", () => {
    for (const line of ["№ 4821", "№4821", "#4821"]) {
      const reading = readAdminQuery(line);
      expect(reading.orderNumber, line).toBe(4821);
      expect(reading.phoneDigits, line).toBeNull();
      expect(reading.article, line).toBeNull();
    }
  });

  it("reads a phone number in any spelling", () => {
    expect(readAdminQuery("+7 701 123 45 67").phoneDigits).toEqual(["77011234567"]);
    expect(readAdminQuery("8 701 123 45 67").phoneDigits).toEqual(["87011234567", "77011234567"]);
    expect(readAdminQuery("+7 701 123 45 67").orderNumber).toBeNull();
  });

  it("reads twelve digits as a БИН", () => {
    const reading = readAdminQuery("0807 4000 0128");
    expect(reading.bin).toBe("080740000128");
    expect(reading.phoneDigits).toBeNull();
    expect(reading.orderNumber).toBeNull();
    expect(reading.article).toBeNull();
  });

  it("reads an article in any spelling", () => {
    for (const line of ["04465-0K090", "04465 0k090", "044650K090"]) {
      expect(readAdminQuery(line).article, line).toBe("044650K090");
    }
    expect(readAdminQuery("4050068800").article).toBe("4050068800");
    expect(readAdminQuery("GDB3534").article).toBe("GDB3534");
  });

  it("reads letters as a text to find by name", () => {
    const reading = readAdminQuery("  Автомаркет ");
    expect(reading.text).toBe("Автомаркет");
    expect(reading.article).toBeNull();
    expect(reading.phoneDigits).toBeNull();
    expect(readAdminQuery("Helix HX8")).toMatchObject({ text: "Helix HX8", article: "HELIXHX8" });
  });
});
