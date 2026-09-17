import { describe, expect, it } from "vitest";
import {
  contrastExceptions,
  contrastPairs,
  contrastRatio,
  darkColors,
  findContrastViolations,
  lightColors,
  themes,
  type ThemeName,
} from "./index";

describe("contrast of DESIGN.md 7.2 pairs", () => {
  it("computes WCAG ratios like DESIGN.md 4", () => {
    expect(contrastRatio(darkColors.text, darkColors.bg)).toBeCloseTo(16.58, 2);
    expect(contrastRatio(lightColors.accent, lightColors.bg)).toBeCloseTo(4.81, 2);
    expect(contrastRatio(lightColors.onPrimary, lightColors.primary)).toBeCloseTo(9.1, 2);
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
  });

  it.each(["dark", "light"] as ThemeName[])("%s theme: every pair meets its threshold", (name) => {
    const violations = findContrastViolations(name, themes[name].colors);
    expect(
      violations.map(
        (v) =>
          `${v.pair.foreground} on ${v.pair.background}: ${v.ratio.toFixed(2)} < ${v.required}`,
      ),
    ).toEqual([]);
  });

  it("checks text pairs at 4.5:1 and field borders and focus at 3:1", () => {
    const kinds = new Set(contrastPairs.map((pair) => `${pair.foreground}:${pair.kind}`));
    expect(kinds).toContain("text:text");
    expect(kinds).toContain("accentOnTint:text");
    expect(kinds).toContain("borderField:non-text");
    expect(kinds).toContain("accent:non-text");
    expect(contrastPairs.length).toBeGreaterThan(50);
  });

  it("fails when a pair is spoiled", () => {
    const spoiled = { ...lightColors, textMuted: "#A39C8F" };
    const violations = findContrastViolations("light", spoiled);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]).toMatchObject({ pair: { foreground: "textMuted" }, required: 4.5 });

    const pale = { ...darkColors, borderField: "#3A3B40" };
    expect(findContrastViolations("dark", pale)).toContainEqual(
      expect.objectContaining({
        pair: expect.objectContaining({ foreground: "borderField" }),
        required: 3,
      }),
    );
  });

  it("allows only the documented exceptions, which really are below 4.5:1", () => {
    expect(contrastExceptions).toHaveLength(2);
    for (const exception of contrastExceptions) {
      const colors = themes[exception.theme].colors;
      const ratio = contrastRatio(colors[exception.foreground], colors[exception.background]);
      expect(ratio).toBeLessThan(4.5);
      expect(ratio).toBeGreaterThan(4.2);
      // The replacement text color does pass there.
      expect(
        contrastRatio(colors.accentOnTint, colors[exception.background]),
      ).toBeGreaterThanOrEqual(4.5);
    }
    // The same pairs in the dark theme are not exempt.
    expect(findContrastViolations("dark", darkColors, contrastPairs, [])).toEqual([]);
  });
});
