import { typography } from "@adclub/ui-core";

/**
 * The label of a `SelectButton` (DESIGN.md 7.7 «Кнопка выбора», TASK-030.C),
 * apart from the component so a plain Node test can check it: the geometry of
 * the button and the one rule of its font size.
 *
 * The app sizes the label itself instead of React Native's
 * `adjustsFontSizeToFit`: on iOS with the new architecture that prop ignores
 * `minimumFontScale` (it reads only the iOS `minimumFontSize`, 4 pt by
 * default) and counts a label as not fitting when its frame is a fraction
 * lower than its fixed line height — then «Алматы» shrank to a few points.
 */
export const selectLabelMetrics = {
  /** Left and right of the button content. */
  paddingX: 10,
  /** Between the icon, the label and the caret. */
  gap: 6,
  /** The icon and the caret. */
  icon: 16,
  /** 14 Medium. */
  fontSize: typography.bodyS.fontSize,
  /** «Не больше чем до 85 %»: 12, never smaller. */
  minFontSize: Math.round(typography.bodyS.fontSize * 0.85),
} as const;

/**
 * The font size of a label `natural` wide at full size in a box `available`
 * wide (both as drawn, so the system font scale cancels out): full size when
 * it fits, a little smaller when that is enough — never below the minimum,
 * past which the label ends in an ellipsis. Until both widths are known the
 * label keeps its full size.
 */
export function selectLabelFontSize(
  natural: number,
  available: number,
  { fontSize, minFontSize } = selectLabelMetrics,
): number {
  if (!(natural > 0) || !(available > 0) || natural <= available) return fontSize;
  // Glyph advances do not scale exactly with the size (rounding to the
  // pixel), so the label aims a hair under the exact ratio and is never cut
  // by a fraction of a point.
  const fitting = Math.floor(((fontSize * available) / natural) * 0.99 * 10) / 10;
  return Math.max(minFontSize, Math.min(fontSize, fitting));
}
