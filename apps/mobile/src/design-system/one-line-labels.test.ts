import { join } from "node:path";
import { mobileText, type MobileTextKey } from "@adclub/i18n";
import { fontScale, layout, typography } from "@adclub/ui-core";
import * as fontkit from "fontkit";
import { describe, expect, it } from "vitest";
import { segmentMetrics } from "./segment-metrics";

// Plain Node checks: this file must not import react-native. They measure
// the labels with the font the app draws them in (Onest Medium), so «fits
// one line» is a number, not a hope (TASK-030.A, AC-2, AC-4).
const font = fontkit.openSync(join(__dirname, "../../assets/fonts/Onest-Medium.ttf"));
if (!("layout" in font)) throw new Error("font collection");
const width = (text: string, size: number) =>
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

describe("the car button of the catalog header (TASK-030.A)", () => {
  it("fits «Geely Atlas 2023» in half of a 375-pt screen, shrinking it no more than it may", () => {
    // Half the row, minus the frame, the side padding, the icon 16, the caret 16 and two gaps of 6.
    const half = (375 - 2 * layout.screenPadding - 8) / 2;
    const forText = half - 2 - 2 * 10 - 16 - 16 - 2 * 6;
    const minimumFontScale = 0.85;
    expect(width("Geely Atlas 2023", typography.bodyS.fontSize) * minimumFontScale).toBeLessThan(
      forText,
    );
  });
});
