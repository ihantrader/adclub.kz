/**
 * The geometry of `Segments` (TASK-030.A), apart from the component so a
 * plain Node test can check that the sort labels fit one line: the inset of
 * the container around the thumb and the side padding of each option.
 */
export const segmentMetrics = {
  /** Between the container and the thumb, every side. */
  inset: 2,
  /** Left and right of a label inside its option. */
  paddingX: 10,
} as const;
