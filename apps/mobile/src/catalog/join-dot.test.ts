import { describe, expect, it } from "vitest";
import { DOT, joinDot, NBSP } from "./format";

// Plain Node checks of the one separator of a line (TASK-078 M11).

describe("joinDot — parts of one line through «·»", () => {
  it("binds the dot to both neighbours with non-breaking spaces", () => {
    expect(DOT).toBe(`${NBSP}·${NBSP}`);
    expect(NBSP).toBe(" ");
    expect(joinDot(["Geely", "04465-0K090"])).toBe("Geely · 04465-0K090");
  });

  it("never starts or ends a line with a dot: empty parts are left out", () => {
    expect(joinDot([null, "1 шт.", undefined, "", "12 700 ₸", false, "  "])).toBe(
      "1 шт. · 12 700 ₸",
    );
    expect(joinDot([null, undefined])).toBe("");
    expect(joinDot(["только одна часть"])).toBe("только одна часть");
  });

  it("holds the parts together at a break: there is no ordinary space next to the dot", () => {
    const line = joinDot(["от 8 000 ₸ для Coolray", "1 предложение"]);
    expect(line).not.toMatch(/ ·| · |· /);
  });
});
