/** Between two secondary actions side by side — `--ac-space-2`. */
export const ACTION_BAR_GAP = 8;

/** Per button, against the rounding of text widths. */
const SLACK = 1;

/**
 * Whether two secondary actions of `ActionBar` stand side by side in halves
 * (TASK-079.A): only when each of them — icon, label in one line and its
 * side padding, `widths` — fits its own half of `available`, the width of
 * the bar's own container (a narrow side column on a wide screen is narrow).
 * Otherwise each goes across the whole width, one under the other. Until
 * both widths are known — each across: a label never wraps, even for a frame.
 */
export function fitsInHalves(
  available: number,
  widths: readonly [number, number],
  gap: number = ACTION_BAR_GAP,
): boolean {
  if (!(available > 0) || !(widths[0] > 0) || !(widths[1] > 0)) return false;
  const half = (available - gap) / 2;
  return widths[0] + SLACK <= half && widths[1] + SLACK <= half;
}
