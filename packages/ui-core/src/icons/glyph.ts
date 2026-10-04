/**
 * A glyph of the icon set (Phosphor Light, D-067; ARCHITECTURE 4.43): the
 * paths of one icon on Phosphor's 256 grid. Phosphor ships its weights as
 * filled outlines; the few glyphs we draw ourselves (car parts Phosphor has
 * no icon for) are strokes of the same Light width — `stroke: true`. Both
 * platforms draw a glyph the same way: fill the outlines, stroke the rest.
 */
export interface GlyphPath {
  readonly d: string;
  /** Drawn as a line of `glyphGrid.lightStroke` with round ends, not filled. */
  readonly stroke?: true;
}

export type Glyph = readonly GlyphPath[];

export const glyphGrid = {
  viewBox: "0 0 256 256",
  /** The width of a Light line on the 256 grid (≈1.1 px at 24). */
  lightStroke: 12,
} as const;
