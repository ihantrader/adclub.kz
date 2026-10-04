/** Typography — DESIGN.md 5 and 7.4 (D-068, "light design"). */

/** Onest weights of the interface: Light, Regular, Medium. 700 is not used (D-068); 800 is only in the logo (SVG). */
export type FontWeight = 300 | 400 | 500;

/**
 * Light 300 only from this size up (DESIGN.md 7.4): below it a thin face stops
 * reading on the dark background and with a large system font. The tokens test
 * holds every token to it; screens get weights only through tokens.
 */
export const lightMinFontSize = 24;

export interface TextStyleToken {
  fontSize: number;
  lineHeight: number;
  fontWeight: FontWeight;
  /** Prices, quantities, codes and timers use tabular figures (DESIGN.md 5). */
  tabularNums: boolean;
}

export type TypographyToken =
  | "titleL"
  | "title"
  | "heading"
  | "body"
  | "bodyStrong"
  | "bodyS"
  | "caption"
  | "captionStrong"
  | "label"
  | "tab"
  | "price"
  | "priceS"
  | "code"
  | "codeXL";

function style(
  fontSize: number,
  lineHeight: number,
  fontWeight: FontWeight,
  tabularNums = false,
): TextStyleToken {
  return { fontSize, lineHeight, fontWeight, tabularNums };
}

export const typography: Record<TypographyToken, TextStyleToken> = {
  titleL: style(28, 34, 300),
  title: style(20, 26, 400),
  heading: style(18, 24, 400),
  body: style(16, 22, 400),
  bodyStrong: style(16, 22, 500),
  bodyS: style(14, 20, 400),
  caption: style(12, 16, 400),
  captionStrong: style(12, 16, 500),
  label: style(16, 20, 500),
  tab: style(11, 14, 500),
  price: style(22, 28, 400, true),
  priceS: style(16, 20, 500, true),
  code: style(32, 36, 300, true),
  codeXL: style(40, 44, 300, true),
};

export const fontFamily = {
  /** Interface family name (web `font-family`). */
  name: "Onest",
  /**
   * Web fallback while Onest loads or if it fails: system fonts that carry
   * the Kazakh Cyrillic letters, `№` and `₸` (Segoe UI, Roboto, SF, Arial).
   */
  webFallback:
    '"Onest Fallback", system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  /** React Native: one registered family per weight (Android ignores `fontWeight` for custom fonts). */
  native: {
    300: "Onest-Light",
    400: "Onest-Regular",
    500: "Onest-Medium",
  } satisfies Record<FontWeight, string>,
} as const;

/** System font scale limits (DESIGN.md 7.4). */
export const fontScale = {
  /** Tab labels grow at most to 120 %. */
  tabLabelMax: 1.2,
  /** Screens are checked at 100 % and 130 %; up to 200 % text wraps, never clips. */
  checked: [1, 1.3, 2],
} as const;
