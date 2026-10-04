import { ORDER_CODE_LENGTH, size } from "@adclub/ui-core";

/**
 * The geometry of `CodeCells` (DESIGN.md 7.10, TASK-030.C), apart from the
 * component so a plain Node test can check that six cells fit a narrow phone:
 * two groups of three, cells 48 wide and narrower only when the row does not
 * fit — down to 36, like the web (`.ac-code__cell`). Where even 36 does not
 * fit with the usual gaps (the showcase block of a 320-pt phone), the gaps
 * close up too.
 */
export const codeCellMetrics = {
  /** Between the cells of a group. */
  gap: 8,
  /** Between the two groups. */
  groupGap: 16,
  /** The gaps when the cells are at their narrowest and still do not fit. */
  tightGap: 4,
  tightGroupGap: 12,
  maxWidth: size.codeCell.width,
  minWidth: 36,
} as const;

export interface CodeCellLayout {
  cell: number;
  gap: number;
  groupGap: number;
}

const GROUPS = 2;

/** The row of six cells in `width`: the width of a cell and the two gaps. */
export function codeRowWidth({ cell, gap, groupGap }: CodeCellLayout): number {
  return ORDER_CODE_LENGTH * cell + (ORDER_CODE_LENGTH - GROUPS) * gap + (GROUPS - 1) * groupGap;
}

/** The cells in a row `available` wide (unknown yet — full width). */
export function codeCellLayout(available: number, metrics = codeCellMetrics): CodeCellLayout {
  const usual = { gap: metrics.gap, groupGap: metrics.groupGap };
  if (!(available > 0)) return { cell: metrics.maxWidth, ...usual };
  const gaps = codeRowWidth({ cell: 0, ...usual });
  const fitting = Math.floor((available - gaps) / ORDER_CODE_LENGTH);
  if (fitting >= metrics.minWidth) {
    return { cell: Math.min(metrics.maxWidth, fitting), ...usual };
  }
  return { cell: metrics.minWidth, gap: metrics.tightGap, groupGap: metrics.tightGroupGap };
}
