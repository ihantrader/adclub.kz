import { join } from "node:path";
import { mobileText, type MobileTextKey } from "@adclub/i18n";
import { fontScale, layout, line, typography } from "@adclub/ui-core";
import * as fontkit from "fontkit";
import { describe, expect, it } from "vitest";
import { codeCellLayout, codeCellMetrics, codeRowWidth } from "./code-cell-metrics";
import { segmentMetrics } from "./segment-metrics";
import { selectLabelFontSize, selectLabelMetrics } from "./select-label";

// Plain Node checks: this file must not import react-native. They measure
// the labels with the font the app draws them in (Onest Medium), so «fits
// one line» is a number, not a hope (TASK-030.A, AC-2, AC-4).
const open = (file: string) => {
  const font = fontkit.openSync(join(__dirname, "../../assets/fonts", file));
  if (!("layout" in font)) throw new Error("font collection");
  return font;
};
const medium = open("Onest-Medium.ttf");
const light = open("Onest-Light.ttf");
const width = (text: string, size: number, font = medium) =>
  (font.layout(text).advanceWidth / font.unitsPerEm) * size;

const LANGS = ["ru", "kk", "en"] as const;
const LIST_SORTS: MobileTextKey[] = [
  "catalog.sort.recommended",
  "catalog.sort.cheaper",
  "catalog.sort.faster",
];

describe("the sort segments of the list (TASK-030.A)", () => {
  it.each(LANGS)(
    "%s: «Рекомендуем · Дешевле · Быстрее» fit one line of a 360-pt phone at the largest label size",
    (lang) => {
      const size = typography.bodyS.fontSize * fontScale.tabLabelMax;
      const labels = LIST_SORTS.map((key) => width(mobileText(lang, key), size));
      const needed = labels.reduce((sum, label) => sum + label + 2 * segmentMetrics.paddingX, 0);
      const available = 360 - 2 * layout.screenPadding - 2 * segmentMetrics.inset;
      expect(needed, `${lang}: ${Math.round(needed)} of ${available}`).toBeLessThanOrEqual(
        available,
      );
    },
  );

  it("say the short words of the Product Owner", () => {
    expect(LIST_SORTS.map((key) => mobileText("ru", key))).toEqual([
      "Рекомендуем",
      "Дешевле",
      "Быстрее",
    ]);
  });
});

describe("the label of a select button (TASK-030.C)", () => {
  const { fontSize, minFontSize } = selectLabelMetrics;

  it("keeps 14, shrinks no further than 12 and keeps 14 until both widths are known", () => {
    expect(minFontSize).toBe(12);
    expect(selectLabelFontSize(50, 100)).toBe(fontSize);
    expect(selectLabelFontSize(100, 100)).toBe(fontSize);
    expect(selectLabelFontSize(0, 100)).toBe(fontSize);
    expect(selectLabelFontSize(100, 0)).toBe(fontSize);
    expect(selectLabelFontSize(1000, 10)).toBe(minFontSize);
    const slightly = selectLabelFontSize(105, 100);
    expect(slightly).toBeLessThan(fontSize);
    expect(slightly).toBeGreaterThan(minFontSize);
    // What shrinks fits: the label is not cut by a fraction of a point.
    expect((105 * slightly) / fontSize).toBeLessThanOrEqual(100);
  });

  it("is never below 12 and never above 14, whatever the widths", () => {
    for (let natural = 1; natural <= 400; natural += 3.7) {
      for (let available = 1; available <= 200; available += 2.9) {
        const size = selectLabelFontSize(natural, available);
        expect(size).toBeGreaterThanOrEqual(minFontSize);
        expect(size).toBeLessThanOrEqual(fontSize);
      }
    }
  });

  // Half the header row (TASK-030.A: two buttons, a gap of 8) minus the frame,
  // the side padding, the icon, the caret and the two gaps between them.
  const forText = (screen: number) => {
    const { paddingX, gap, icon } = selectLabelMetrics;
    const half = (screen - 2 * layout.screenPadding - 8) / 2;
    return half - 2 * line.width - 2 * paddingX - 2 * icon - 2 * gap;
  };
  // The size the phone draws, and whether an ellipsis follows. The system font
  // scale multiplies both widths the same way, up to the 120 % cap.
  const drawn = (text: string, screen: number, scale = 1) => {
    const multiplier = Math.min(scale, fontScale.tabLabelMax);
    const natural = width(text, fontSize) * multiplier;
    const available = forText(screen);
    const size = selectLabelFontSize(natural, available);
    return { size, ellipsis: (natural * size) / fontSize > available };
  };

  it.each([
    ["Алматы", 375],
    ["Алматы", 320],
    ["Өскемен", 375],
    ["Петропавл", 375],
    ["Весь Казахстан", 390],
    ["Бүкіл Қазақстан", 393],
    ["All Kazakhstan", 375],
    ["Geely Coolray", 375],
  ])("%s on a %i-pt phone keeps 14", (text, screen) => {
    expect(drawn(text, screen)).toEqual({ size: fontSize, ellipsis: false });
  });

  it.each([
    ["Geely Atlas 2025", 390],
    ["Geely Atlas 2023", 375],
    ["Весь Казахстан", 375],
    ["Бүкіл Қазақстан", 375],
  ])("%s on a %i-pt phone shrinks a little and fits whole", (text, screen) => {
    const { size, ellipsis } = drawn(text, screen);
    expect(size).toBeLessThan(fontSize);
    expect(size).toBeGreaterThanOrEqual(minFontSize);
    expect(ellipsis).toBe(false);
  });

  it.each([
    ["Geely Atlas Pro 2024", 375],
    ["Chery Tiggo 7 Pro 2024", 390],
    ["Усть-Каменогорск", 320],
    ["Geely Atlas 2025", 320],
  ])("%s on a %i-pt phone stops at 12 and ends in an ellipsis", (text, screen) => {
    expect(drawn(text, screen)).toEqual({ size: minFontSize, ellipsis: true });
  });

  it.each([1.3, 2])("at a system font of %f a short value grows only to 120 %", (scale) => {
    const { size, ellipsis } = drawn("Алматы", 375, scale);
    expect(size).toBe(fontSize);
    expect(ellipsis).toBe(false);
    expect(drawn("Geely Atlas Pro 2024", 375, scale).size).toBe(minFontSize);
  });
});

describe("the code cells (TASK-030.C)", () => {
  const { maxWidth, minWidth } = codeCellMetrics;

  it("keep 48 and the usual gaps where they fit", () => {
    expect(codeCellLayout(0).cell).toBe(maxWidth);
    expect(codeCellLayout(375 - 2 * layout.screenPadding)).toEqual({
      cell: maxWidth,
      gap: codeCellMetrics.gap,
      groupGap: codeCellMetrics.groupGap,
    });
  });

  it.each([
    ["a 320-pt screen", 320 - 2 * layout.screenPadding],
    ["the showcase block of a 375-pt phone", 375 - 4 * 16],
    ["the showcase block of a 320-pt phone", 320 - 4 * 16],
  ])("fit %s, cells not narrower than 36", (_, available) => {
    const cells = codeCellLayout(available);
    expect(cells.cell).toBeGreaterThanOrEqual(minWidth);
    expect(cells.cell).toBeLessThanOrEqual(maxWidth);
    expect(codeRowWidth(cells)).toBeLessThanOrEqual(available);
  });

  it("shrink the cells before the gaps", () => {
    const narrow = codeCellLayout(320 - 2 * layout.screenPadding);
    expect(narrow.cell).toBeLessThan(maxWidth);
    expect(narrow.gap).toBe(codeCellMetrics.gap);
  });

  it("hold the widest digit at codeXL (Onest Light 40) inside the narrowest cell", () => {
    const widest = Math.max(
      ...[..."0123456789"].map((digit) => width(digit, typography.codeXL.fontSize, light)),
    );
    expect(widest).toBeLessThanOrEqual(minWidth - 2 * line.width);
  });
});
