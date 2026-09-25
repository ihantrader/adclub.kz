import { describe, expect, it } from "vitest";
import { countsInStatistics } from "./order-statistics";

describe("countsInStatistics", () => {
  it("counts an ordinary order", () => {
    expect(countsInStatistics({ isTest: false })).toBe(true);
  });

  it("leaves an employee's own order with their company out (PRODUCT 12.6)", () => {
    expect(countsInStatistics({ isTest: true })).toBe(false);
  });

  it("decides by nothing but the test mark", () => {
    // Whatever else a row holds, the rule is one field: a status, a
    // supplier or a date never makes a test order count (TASK-050, TASK-034
    // take this function as it is).
    const row = { isTest: true, status: "completed", supplierId: "s", total: 13_000 };
    expect(countsInStatistics(row)).toBe(false);
  });
});
