import type { ColorToken, ColorTokens } from "./tokens/colors";
import type { ThemeName } from "./theme";

/** WCAG 2.x relative luminance of `#RRGGBB`. */
export function relativeLuminance(hex: string): number {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match?.[1]) throw new Error(`Expected #RRGGBB, got "${hex}"`);
  const value = match[1];
  const [r, g, b] = [0, 2, 4].map((offset) => {
    const channel = parseInt(value.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export const TEXT_MIN_CONTRAST = 4.5;
export const NON_TEXT_MIN_CONTRAST = 3;

export interface ContrastPair {
  foreground: ColorToken;
  background: ColorToken;
  kind: "text" | "non-text";
  /** Where the pair is used (DESIGN.md reference). */
  usage: string;
}

export interface ContrastException {
  theme: ThemeName;
  foreground: ColorToken;
  background: ColorToken;
  reason: string;
}

const textColors: ColorToken[] = [
  "text",
  "textMuted",
  "accent",
  "success",
  "warning",
  "danger",
  "ai",
];
const screenBackgrounds: ColorToken[] = ["bg", "bar", "surface", "surfaceRaised"];

/** Pairs DESIGN.md 7.2 and 7.12 require, in both themes. */
export const contrastPairs: readonly ContrastPair[] = [
  ...textColors.flatMap((foreground) =>
    screenBackgrounds.map((background): ContrastPair => ({
      foreground,
      background,
      kind: "text",
      usage: "7.2: text roles on screen, bar and card backgrounds",
    })),
  ),
  ...textColors.map((foreground): ContrastPair => ({
    foreground,
    background: "fill",
    kind: "text",
    usage: "7.7: text on secondary buttons, chips and neutral badges",
  })),
  ...(
    [
      ["success", "successTint"],
      ["warning", "warningTint"],
      ["danger", "dangerTint"],
      ["ai", "aiTint"],
      ["accentOnTint", "accentTint"],
      ["accentOnTint", "fill"],
      ["text", "successTint"],
      ["text", "warningTint"],
      ["text", "dangerTint"],
      ["text", "aiTint"],
      ["textMuted", "aiTint"],
      ["textMuted", "accentTint"],
      ["onPrimary", "primary"],
      ["onDanger", "danger"],
      ["onToast", "toast"],
    ] as const
  ).map(([foreground, background]): ContrastPair => ({
    foreground,
    background,
    kind: "text",
    usage: "7.2, 7.7–7.9: text on role backgrounds, buttons and toasts",
  })),
  ...(["bg", "surface", "surfaceRaised"] as const).flatMap((background): ContrastPair[] => [
    {
      foreground: "borderField",
      background,
      kind: "non-text",
      usage: "7.2, 7.12: field and checkbox borders",
    },
    {
      foreground: "accent",
      background,
      kind: "non-text",
      usage: "7.7, 7.12: focus ring",
    },
  ]),
];

/** Known exceptions from DESIGN.md 4 and 7.2: those places use `accentOnTint`. */
export const contrastExceptions: readonly ContrastException[] = [
  {
    theme: "light",
    foreground: "accent",
    background: "fill",
    reason: "DESIGN.md 7.2: bronze on fill is 4.3:1 — text there is accentOnTint",
  },
  {
    theme: "light",
    foreground: "accent",
    background: "accentTint",
    reason: "DESIGN.md 7.2: bronze on accentTint is 4.3:1 — text there is accentOnTint",
  },
];

export interface ContrastViolation {
  theme: ThemeName;
  pair: ContrastPair;
  ratio: number;
  required: number;
}

export function findContrastViolations(
  theme: ThemeName,
  colors: ColorTokens,
  pairs: readonly ContrastPair[] = contrastPairs,
  exceptions: readonly ContrastException[] = contrastExceptions,
): ContrastViolation[] {
  return pairs.flatMap((pair) => {
    const excepted = exceptions.some(
      (exception) =>
        exception.theme === theme &&
        exception.foreground === pair.foreground &&
        exception.background === pair.background,
    );
    if (excepted) return [];
    const required = pair.kind === "text" ? TEXT_MIN_CONTRAST : NON_TEXT_MIN_CONTRAST;
    const ratio = contrastRatio(colors[pair.foreground], colors[pair.background]);
    return ratio < required ? [{ theme, pair, ratio, required }] : [];
  });
}
