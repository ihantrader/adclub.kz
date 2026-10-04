import { glyphGrid, uiFilledGlyphs, uiGlyphs, type IconName } from "@adclub/ui-core";

/**
 * The glyphs behind the shared semantic names (Phosphor Light, D-067,
 * DESIGN.md 7.6). Which glyph draws which icon is decided once, in
 * design/icons/icons.mjs, for the web and the app alike (`pnpm icons`).
 */
export const icons = uiGlyphs;

export type IconSize = 16 | 20 | 24 | 28 | 48;

export interface IconProps {
  name: IconName;
  /** 16 · 20 · 24; 48 — empty states and outcomes. */
  size?: IconSize;
  className?: string;
  /** Decorative by default; pass a label only when the icon alone carries meaning. */
  label?: string;
  /** The filled form, where the icon has one (the star of a rating). */
  filled?: boolean;
}

export function Icon({ name, size = 20, className, label, filled }: IconProps) {
  const glyph = (filled ? uiFilledGlyphs[name] : undefined) ?? uiGlyphs[name];
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox={glyphGrid.viewBox}
      className={className ? `ac-icon ${className}` : "ac-icon"}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
      focusable="false"
    >
      {glyph.map((part, index) =>
        part.stroke ? (
          <path
            key={index}
            d={part.d}
            fill="none"
            stroke="currentColor"
            strokeWidth={glyphGrid.lightStroke}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : (
          <path key={index} d={part.d} fill="currentColor" />
        ),
      )}
    </svg>
  );
}
