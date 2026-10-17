/**
 * The geometry of `Segments` (TASK-030.A), apart from the component so a
 * plain Node test can check that the sort labels fit: the inset of the
 * container around the thumb, the side padding of each option and how far
 * a label may give way before the options go to a second row (TASK-078.A).
 */
export const segmentMetrics = {
  /** Between the container and the thumb, every side. */
  inset: 2,
  /** Left and right of a label inside its option. */
  paddingX: 10,
  /** The least side padding a crowded row keeps. */
  minPaddingX: 4,
  /** The least label size against `bodyS` — 12 of 14, the floor of `SelectButton` (TASK-030.C). */
  minLabelScale: 12 / 14,
  /** Per option, against the rounding of text widths. */
  slack: 1,
} as const;

export interface SegmentsRow {
  /** The options of the row, by their index. */
  options: number[];
  /** Equal cells; otherwise each cell is as wide as its label and the rest is shared equally. */
  equal: boolean;
}

export interface SegmentsLayout {
  rows: SegmentsRow[];
  /** The side padding of every option (the same in every row). */
  paddingX: number;
  /** The label size against `bodyS` (the same in every row). */
  labelScale: number;
}

interface RowFit {
  equal: boolean;
  paddingX: number;
  labelScale: number;
}

/**
 * One row, if its labels fit it whole: equal cells first; cells by their
 * labels when a third (a quarter) is too narrow for the longest; then a
 * narrower padding and a smaller label, no further than the floors.
 */
function fitRow(available: number, widths: readonly number[]): RowFit | null {
  const { paddingX, minPaddingX, minLabelScale, slack } = segmentMetrics;
  const n = widths.length;
  const room = available - slack * n;
  const sum = widths.reduce((total, width) => total + width, 0);
  const longest = Math.max(...widths);
  if (n * (longest + 2 * paddingX) <= room) {
    return { equal: true, paddingX, labelScale: 1 };
  }
  if (sum + 2 * n * paddingX <= room) {
    return { equal: false, paddingX, labelScale: 1 };
  }
  const padding = Math.floor((room - sum) / (2 * n));
  if (padding >= minPaddingX) {
    return { equal: false, paddingX: padding, labelScale: 1 };
  }
  const scale = (room - 2 * n * minPaddingX) / sum;
  if (scale >= minLabelScale) {
    return { equal: false, paddingX: minPaddingX, labelScale: Math.floor(scale * 100) / 100 };
  }
  return null;
}

/**
 * How `Segments` lays out its options across `available` points (the inside
 * of the container), given the width of each label in one line at the size
 * the phone draws it (TASK-078.A). A label is never cut and never wrapped
 * inside a word: the options share one row while their labels fit it, and
 * otherwise go to two rows («Рекомендуем · Дешевле» over «Быстрее ·
 * Рейтинг» on a 320-pt phone) — each row by the same rule.
 *
 * Until both widths are known the options share one row equally.
 */
export function segmentsLayout(available: number, widths: readonly number[]): SegmentsLayout {
  const all = widths.map((_, index) => index);
  const { paddingX, minPaddingX, minLabelScale } = segmentMetrics;
  if (available <= 0 || widths.length === 0 || widths.some((width) => !(width > 0))) {
    return { rows: [{ options: all, equal: true }], paddingX, labelScale: 1 };
  }
  const one = fitRow(available, widths);
  if (one) {
    return {
      rows: [{ options: all, equal: one.equal }],
      paddingX: one.paddingX,
      labelScale: one.labelScale,
    };
  }
  if (widths.length === 1) {
    // A single label wider than the whole control: the smallest size, and
    // the label wraps at its spaces.
    return {
      rows: [{ options: all, equal: true }],
      paddingX: minPaddingX,
      labelScale: minLabelScale,
    };
  }
  // Two rows, the first the longer half; each row by the same rule.
  const half = Math.ceil(widths.length / 2);
  const parts = [all.slice(0, half), all.slice(half)];
  const fits = parts.map((part) =>
    fitRow(
      available,
      part.map((index) => widths[index]!),
    ),
  );
  return {
    rows: parts.map((options, index) => ({ options, equal: fits[index]?.equal ?? false })),
    paddingX: Math.min(...fits.map((fit) => fit?.paddingX ?? minPaddingX)),
    labelScale: Math.min(...fits.map((fit) => fit?.labelScale ?? minLabelScale)),
  };
}
