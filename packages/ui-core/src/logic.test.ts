import { describe, expect, it, vi } from "vitest";
import {
  aiPilotButtonColorway,
  clampQuantity,
  compatibilityMarks,
  createPressGuard,
  createQrMatrix,
  formatOrderCode,
  isPressBlocked,
  nextBlinkDelay,
  orderStatusGroups,
  qrPath,
  quantityControls,
  motion,
  sanitizeOrderCode,
  selectAiPilotState,
  sheetMotion,
  shouldAiPilotBlink,
  splitOrderCode,
  toneColors,
} from "./index";

describe("order code", () => {
  it("groups six digits as 3 + 3", () => {
    expect(splitOrderCode("482915")).toEqual(["482", "915"]);
    expect(formatOrderCode("482915")).toBe("482 915");
  });

  it("formats partial input without a trailing space", () => {
    expect(formatOrderCode("")).toBe("");
    expect(formatOrderCode("48")).toBe("48");
    expect(formatOrderCode("482")).toBe("482");
    expect(formatOrderCode("4829")).toBe("482 9");
  });

  it("keeps only six digits from typed or pasted text", () => {
    expect(sanitizeOrderCode("482 915")).toBe("482915");
    expect(sanitizeOrderCode("код: 48-29-15-77")).toBe("482915");
    expect(sanitizeOrderCode("abc")).toBe("");
  });
});

describe("press guard (loading button)", () => {
  it("runs a synchronous action every time", () => {
    const action = vi.fn();
    const guard = createPressGuard();
    expect(guard.run(action)).toBe(true);
    expect(guard.run(action)).toBe(true);
    expect(action).toHaveBeenCalledTimes(2);
    expect(guard.isBusy()).toBe(false);
  });

  it("ignores repeated presses in the same tick while a promise is pending", async () => {
    let finish: () => void = () => undefined;
    const action = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const busy = vi.fn();
    const guard = createPressGuard(busy);

    expect(guard.run(action)).toBe(true);
    // Double click / repeated Enter before any re-render.
    expect(guard.run(action)).toBe(false);
    expect(guard.run(action)).toBe(false);
    expect(action).toHaveBeenCalledTimes(1);
    expect(busy).toHaveBeenLastCalledWith(true);

    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(guard.isBusy()).toBe(false);
    expect(busy).toHaveBeenLastCalledWith(false);
    expect(guard.run(action)).toBe(true);
    expect(action).toHaveBeenCalledTimes(2);
  });

  it("releases the lock when the action fails", async () => {
    const guard = createPressGuard();
    guard.run(() =>
      Promise.reject(new Error("network")).catch(() => Promise.reject(new Error("x"))),
    );
    expect(guard.isBusy()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(guard.isBusy()).toBe(false);
    expect(() =>
      guard.run(() => {
        throw new Error("sync");
      }),
    ).toThrow("sync");
    expect(guard.isBusy()).toBe(false);
  });

  it("blocks presses while loading or disabled", () => {
    expect(isPressBlocked({})).toBe(false);
    expect(isPressBlocked({ loading: true })).toBe(true);
    expect(isPressBlocked({ disabled: true })).toBe(true);
  });
});

describe("quantity", () => {
  it("disables minus at the minimum of 1", () => {
    expect(quantityControls(1)).toEqual({ canDecrease: false, canIncrease: true });
    expect(quantityControls(2)).toEqual({ canDecrease: true, canIncrease: true });
    expect(quantityControls(5, 1, 5)).toEqual({ canDecrease: true, canIncrease: false });
  });

  it("clamps values", () => {
    expect(clampQuantity(0)).toBe(1);
    expect(clampQuantity(7, 1, 5)).toBe(5);
    expect(clampQuantity(Number.NaN)).toBe(1);
    expect(clampQuantity(2.6)).toBe(3);
  });
});

describe("AI Pilot", () => {
  it("selects the state from the assistant activity", () => {
    expect(selectAiPilotState({})).toBe("idle");
    expect(selectAiPilotState({ outcome: null })).toBe("idle");
    expect(selectAiPilotState({ listening: true, pending: true })).toBe("listening");
    expect(selectAiPilotState({ pending: true, outcome: "found" })).toBe("thinking");
    expect(selectAiPilotState({ outcome: "found" })).toBe("happy");
    expect(selectAiPilotState({ outcome: "not-found" })).toBe("unsure");
    expect(selectAiPilotState({ outcome: "not-understood" })).toBe("unsure");
    expect(selectAiPilotState({ outcome: "unavailable" })).toBe("unsure");
  });

  it("uses the graphite robot on the champagne button and vice versa", () => {
    expect(aiPilotButtonColorway("dark")).toBe("on-champagne");
    expect(aiPilotButtonColorway("light")).toBe("on-graphite");
  });

  it("blinks only when idle and motion is allowed", () => {
    expect(shouldAiPilotBlink("idle", false)).toBe(true);
    expect(shouldAiPilotBlink("idle", true)).toBe(false);
    expect(shouldAiPilotBlink("thinking", false)).toBe(false);
  });

  it("blinks every 4–6 seconds", () => {
    expect(nextBlinkDelay(() => 0)).toBe(4000);
    expect(nextBlinkDelay(() => 0.5)).toBe(5000);
    expect(nextBlinkDelay(() => 0.999)).toBeLessThanOrEqual(6000);
  });
});

describe("status and compatibility marks", () => {
  it("never colors order outcomes red", () => {
    expect(orderStatusGroups.finished.tone).toBe("neutral");
    expect(orderStatusGroups.waiting.tone).toBe("neutral");
    expect(orderStatusGroups.needsReply.tone).toBe("warning");
    expect(orderStatusGroups.inProgress.tone).toBe("accent");
    expect(orderStatusGroups.ready.tone).toBe("success");
    expect(Object.values(orderStatusGroups).map((group) => group.tone)).not.toContain("danger");
  });

  it("gives every compatibility case its own icon", () => {
    const icons = Object.values(compatibilityMarks).map((mark) => mark.icon);
    expect(new Set(icons).size).toBe(4);
    expect(compatibilityMarks.doesNotFit.color).toBe("danger");
    expect(compatibilityMarks.unknown.color).toBe("textMuted");
  });

  it("puts accent badges in accentOnTint (light accent fails on the tint)", () => {
    expect(toneColors.accent).toEqual({ foreground: "accentOnTint", background: "accentTint" });
  });
});

describe("QR", () => {
  it("builds a square matrix with finder patterns", () => {
    const matrix = createQrMatrix("adclub:order:482915");
    const size = matrix.length;
    expect(size).toBeGreaterThanOrEqual(21);
    expect((size - 17) % 4).toBe(0);
    expect(matrix.every((row) => row.length === size)).toBe(true);
    // Top-left finder: dark 7 × 7 border.
    expect(matrix[0]?.slice(0, 7)).toEqual([true, true, true, true, true, true, true]);
    expect(matrix[1]?.[1]).toBe(false);
    expect(matrix[3]?.[3]).toBe(true);
  });

  it("encodes non-ASCII content", () => {
    expect(() => createQrMatrix("Қ-482915")).not.toThrow();
  });

  it("offsets the path by a 4-module quiet zone", () => {
    const { d, viewBoxSize } = qrPath([
      [true, false],
      [true, true],
    ]);
    expect(viewBoxSize).toBe(10);
    expect(d).toBe("M4 4h1v1h-1zM4 5h2v1h-2z");
  });
});

describe("sheet motion (DESIGN 7.6, 7.7)", () => {
  it("fades the scrim and slides the sheet over 250 ms", () => {
    expect(sheetMotion(false)).toEqual({
      durationMs: motion.slow,
      scrimFades: true,
      sheetSlides: true,
      sheetFades: false,
    });
  });

  it("moves nothing when the system asks for reduced motion", () => {
    const reduced = sheetMotion(true);
    expect(reduced.sheetSlides).toBe(false);
    expect(reduced.sheetFades).toBe(true);
    // The scrim is a layer under the sheet: it never travels with it.
    expect(reduced.scrimFades).toBe(true);
  });
});
