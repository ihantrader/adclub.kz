import { describe, expect, it } from "vitest";
import { dayText, percentText, periodOf, ratingText, statsAddress } from "./stats-rules";

describe("S-STAT-01 — the words of the statistics", () => {
  it("reads the period from the address, 30 days by default", () => {
    expect(periodOf("?period=7")).toBe("7");
    expect(periodOf("?period=90")).toBe("90");
    expect(periodOf("")).toBe("30");
    expect(periodOf("?period=14")).toBe("30");
    expect(statsAddress("30")).toBe("/stats");
    expect(statsAddress("7")).toBe("/stats?period=7");
  });

  it("says a share, the rating and a day as the server gave them", () => {
    expect(percentText(75)).toBe("75 %");
    expect(percentText(null)).toBeNull();
    expect(ratingText(4.6, "ru")).toBe("4,6");
    expect(ratingText(4, "en")).toBe("4.0");
    expect(dayText("2026-11-10", "ru")).toBe("10 ноября");
    expect(dayText("2026-11-10", "en")).toBe("November 10");
  });
});
