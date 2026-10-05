import { describe, expect, it } from "vitest";
import { motion } from "./tokens/shape";
import { TOAST_ACTION_LIFETIME, TOAST_GAP, toastBottomOffset } from "./toast";

describe("where a toast stands (DESIGN 7.7)", () => {
  it("stands 8 above the bottom tabs", () => {
    // A 780-high phone, tabs 64 + a 34 safe area: their top at 682.
    expect(toastBottomOffset(780, [682])).toBe(98 + TOAST_GAP);
  });

  it("clears the highest pinned element — a raised center button, a pinned main button", () => {
    // Tabs at 716, the raised scanner button at 696, a pinned «Сохранить» bar at 644.
    expect(toastBottomOffset(780, [716, 696])).toBe(84 + TOAST_GAP);
    expect(toastBottomOffset(780, [716, 696, 644])).toBe(136 + TOAST_GAP);
  });

  it("leaves the safe area to the platform when nothing is pinned or nothing pinned is on screen", () => {
    expect(toastBottomOffset(780, [])).toBeNull();
    expect(toastBottomOffset(780, [780, 900, Number.NaN])).toBeNull();
  });

  it("never asks for more than the viewport", () => {
    expect(toastBottomOffset(780, [-40])).toBe(780 + TOAST_GAP);
  });

  it("keeps a toast with an action longer than a plain one", () => {
    expect(TOAST_ACTION_LIFETIME).toBeGreaterThan(motion.toast);
  });
});
