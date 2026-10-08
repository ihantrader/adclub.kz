import { describe, expect, it } from "vitest";
import { latestVehicleYear } from "./vehicle-years";

describe("latestVehicleYear", () => {
  it("is the current year in Almaty", () => {
    expect(latestVehicleYear(new Date("2026-10-08T12:00:00Z"))).toBe(2026);
  });

  it("turns over at midnight in Almaty, not in UTC", () => {
    // 2026-12-31 19:30 UTC is 2027-01-01 00:30 in Almaty (UTC+5).
    expect(latestVehicleYear(new Date("2026-12-31T19:30:00Z"))).toBe(2027);
    expect(latestVehicleYear(new Date("2026-12-31T18:30:00Z"))).toBe(2026);
  });
});
