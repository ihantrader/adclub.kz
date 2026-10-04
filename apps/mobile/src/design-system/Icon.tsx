import {
  glyphGrid,
  uiFilledGlyphs,
  uiGlyphs,
  type ColorToken,
  type Glyph,
  type IconName,
} from "@adclub/ui-core";
import { Platform } from "react-native";
import Svg, { Path } from "react-native-svg";
import { useTheme } from "./theme";

/**
 * The glyphs of the semantic icons (Phosphor Light, D-067). Which glyph
 * draws which icon is decided once, in design/icons/icons.mjs, for the app
 * and the web alike (`pnpm icons`); a screen asks for `car` or `mapPin` and
 * never for a glyph, so changing the set changes no screen.
 */
export const icons = uiGlyphs;

// The props that keep a decorative drawing away from screen readers. On the
// web react-native-svg hands its props to the DOM, where these are unknown
// attributes — there the element is hidden with `aria-hidden` instead.
const decorative =
  Platform.OS === "web"
    ? ({ "aria-hidden": true } as object)
    : ({ accessible: false, importantForAccessibility: "no-hide-descendants" } as object);

/** One glyph at a size and a colour: outlines filled, our own strokes stroked (`glyphGrid`). */
export function GlyphIcon({ glyph, size, color }: { glyph: Glyph; size: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox={glyphGrid.viewBox} {...decorative}>
      {glyph.map((part, index) =>
        part.stroke ? (
          <Path
            key={index}
            d={part.d}
            fill="none"
            stroke={color}
            strokeWidth={glyphGrid.lightStroke}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : (
          <Path key={index} d={part.d} fill={color} />
        ),
      )}
    </Svg>
  );
}

export interface IconProps {
  name: IconName;
  size?: 16 | 20 | 24 | 28 | 32 | 48;
  color?: ColorToken;
  /** Explicit color (e.g. on the white code screen). */
  colorValue?: string;
  /** The filled form, where the icon has one (the star of a rating). */
  filled?: boolean;
}

/** A Phosphor Light icon (DESIGN.md 7.6); decorative for screen readers. */
export function Icon({ name, size = 20, color = "text", colorValue, filled }: IconProps) {
  const { theme } = useTheme();
  const glyph = (filled ? uiFilledGlyphs[name] : undefined) ?? uiGlyphs[name];
  return <GlyphIcon glyph={glyph} size={size} color={colorValue ?? theme.colors[color]} />;
}
