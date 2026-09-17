/** Typography — DESIGN.md 5 and 7.4. */

export type FontWeight = 400 | 500 | 700;

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
  titleL: style(24, 30, 700),
  title: style(20, 26, 700),
  heading: style(17, 22, 500),
  body: style(16, 22, 400),
  bodyStrong: style(16, 22, 500),
  bodyS: style(14, 20, 400),
  caption: style(12, 16, 400),
  captionStrong: style(12, 16, 500),
  label: style(16, 20, 500),
  tab: style(11, 14, 500),
  price: style(20, 24, 700, true),
  priceS: style(16, 20, 700, true),
  code: style(32, 36, 700, true),
  codeXL: style(40, 44, 700, true),
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
    400: "Onest-Regular",
    500: "Onest-Medium",
    700: "Onest-Bold",
  } satisfies Record<FontWeight, string>,
} as const;

/** System font scale limits (DESIGN.md 7.4). */
export const fontScale = {
  /** Tab labels grow at most to 120 %. */
  tabLabelMax: 1.2,
  /** Screens are checked at 100 % and 130 %; up to 200 % text wraps, never clips. */
  checked: [1, 1.3, 2],
} as const;
