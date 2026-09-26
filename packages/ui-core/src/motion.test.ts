import { describe, expect, it } from "vitest";
import { motion, motionPlan, screenTransition, sheetMotion, type MotionRole } from "./index";

const ROLES: MotionRole[] = ["state", "appear", "dialog", "sheet", "screen"];

describe("the one rule of motion (DESIGN 7.6)", () => {
  it("is 150 ms for a change of state and 250 ms for sheets and transitions", () => {
    expect(motionPlan("state", false).durationMs).toBe(motion.fast);
    expect(motionPlan("appear", false).durationMs).toBe(motion.fast);
    expect(motionPlan("dialog", false).durationMs).toBe(motion.fast);
    expect(motionPlan("sheet", false).durationMs).toBe(motion.slow);
    expect(motionPlan("screen", false).durationMs).toBe(motion.slow);
    expect(motion.fast).toBe(150);
    expect(motion.slow).toBe(250);
  });

  it("uses the one curve, «замедление в конце», for every role — as numbers and as CSS", () => {
    expect(`cubic-bezier(${motion.bezier.join(", ")})`).toBe(motion.easing);
    for (const role of ROLES) {
      for (const reduced of [false, true]) {
        expect(motionPlan(role, reduced).easing).toEqual(motion.bezier);
      }
    }
    // Deceleration at the end: the curve arrives with no slope, and starts fast.
    const [x1, y1, x2, y2] = motion.bezier;
    expect(y2).toBe(1);
    expect(x2).toBeGreaterThan(x1);
    expect(y1).toBe(0);
  });

  it("moves nothing when the system asks for reduced motion — for any role", () => {
    for (const role of ROLES) {
      expect(motionPlan(role, true).moves).toBe(false);
    }
  });

  it("keeps a change of opacity when motion is reduced, for the same time", () => {
    for (const role of ROLES) {
      const plan = motionPlan(role, true);
      expect(plan.fades).toBe(true);
      expect(plan.durationMs).toBe(motionPlan(role, false).durationMs);
    }
  });

  it("lets a sheet and a screen travel, and a dialog and an appearing thing only fade", () => {
    expect(motionPlan("sheet", false)).toMatchObject({ moves: true, fades: false });
    expect(motionPlan("screen", false)).toMatchObject({ moves: true, fades: false });
    expect(motionPlan("dialog", false)).toMatchObject({ moves: false, fades: true });
    expect(motionPlan("appear", false)).toMatchObject({ moves: false, fades: true });
  });
});

describe("sheet motion (DESIGN 7.6, 7.7)", () => {
  it("is the plan of the sheet role, with the scrim always fading", () => {
    expect(sheetMotion(false)).toEqual({
      durationMs: motion.slow,
      scrimFades: true,
      sheetSlides: true,
      sheetFades: false,
    });
    expect(sheetMotion(true)).toEqual({
      durationMs: motion.slow,
      scrimFades: true,
      sheetSlides: false,
      sheetFades: true,
    });
  });
});

describe("screen transitions", () => {
  it("are the platform's own push and pop, 250 ms where a client can set it", () => {
    expect(screenTransition(false)).toEqual({ kind: "platform", durationMs: motion.slow });
  });

  it("become a fade — nothing slides — when the system asks for reduced motion", () => {
    expect(screenTransition(true)).toEqual({ kind: "fade", durationMs: motion.slow });
  });
});
