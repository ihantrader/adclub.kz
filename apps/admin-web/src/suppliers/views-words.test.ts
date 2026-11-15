import { describe, expect, it } from "vitest";
import { conversionCell, shortDay, viewPeriodRange } from "./views-words";

describe("«Просмотры и заявки» of a supplier (TASK-070)", () => {
  it("takes the period from the address: 7, 30 or 90 days up to today", () => {
    expect(viewPeriodRange("7", "2026-11-15")).toEqual({
      days: 7,
      from: "2026-11-09",
      to: "2026-11-15",
    });
    expect(viewPeriodRange("90", "2026-03-01")).toEqual({
      days: 90,
      from: "2025-12-02",
      to: "2026-03-01",
    });
    // Left out or unknown — 30.
    expect(viewPeriodRange(null, "2026-11-15").from).toBe("2026-10-17");
    expect(viewPeriodRange("365", "2026-11-15").days).toBe(30);
  });

  it("writes a day short and a conversion as per cent, a dash without views", () => {
    expect(shortDay("2026-11-04")).toBe("04.11");
    expect(conversionCell(null)).toBe("—");
    expect(conversionCell(0.05).replaceAll(String.fromCharCode(0xa0), " ")).toBe("5 %");
  });
});
