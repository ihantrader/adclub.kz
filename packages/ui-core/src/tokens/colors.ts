/**
 * Color tokens — DESIGN.md 7.2 (plus the toast colors of 7.7 and the float
 * shadow of 7.6, which also differ per theme). Both themes are typed as
 * `ColorTokens`, so a key added to one theme and forgotten in the other is a
 * type error.
 */
export interface ColorTokens {
  /** Screen background. */
  bg: string;
  /** Bottom tabs, top bar while scrolled, cabinet sidebar. */
  bar: string;
  /** Cards, fields, list rows. */
  surface: string;
  /** Pressed row, nested block, skeleton blocks. */
  surfaceRaised: string;
  /** Secondary button, chip, user message bubble, disabled element. */
  fill: string;
  /** Dividers, card borders. */
  border: string;
  /** Field and checkbox borders (>= 3:1). */
  borderField: string;
  text: string;
  textMuted: string;
  /** Disabled elements (no contrast requirement). */
  textDisabled: string;
  /** "Club price", links, active tab, focus ring, rating. */
  accent: string;
  /** Selected chip, accent badge background. */
  accentTint: string;
  /** Text on `accentTint` (and on `fill`, where light `accent` is 4.3:1). */
  accentOnTint: string;
  /** Primary button, AI Pilot button. */
  primary: string;
  onPrimary: string;
  success: string;
  successTint: string;
  warning: string;
  warningTint: string;
  danger: string;
  dangerTint: string;
  /** Text on the destructive button. */
  onDanger: string;
  /** AI data before a person confirms it — and nothing else (DESIGN.md 7.1). */
  ai: string;
  aiTint: string;
  aiBorder: string;
  /** Dimming under sheets and dialogs. */
  scrim: string;
  /** QR and the full-screen code: black on white in every theme (7.10). */
  qrFg: string;
  qrBg: string;
  /** Toast background and text (7.7). */
  toast: string;
  onToast: string;
}

export type ColorToken = keyof ColorTokens;

export const darkColors: ColorTokens = {
  bg: "#0F1012",
  bar: "#141518",
  surface: "#1A1B1F",
  surfaceRaised: "#202126",
  fill: "#26272C",
  border: "#2A2B30",
  borderField: "#706E67",
  text: "#F2EFE8",
  textMuted: "#9A968D",
  textDisabled: "#5E5C57",
  accent: "#D4B483",
  accentTint: "#2E2718",
  accentOnTint: "#D4B483",
  primary: "#D4B483",
  onPrimary: "#1A1409",
  success: "#6FCF97",
  successTint: "#12301F",
  warning: "#F2C94C",
  warningTint: "#33290C",
  danger: "#F08A7E",
  dangerTint: "#3A1714",
  onDanger: "#1A0806",
  ai: "#7FD1E0",
  aiTint: "#12303A",
  aiBorder: "#4A98A6",
  scrim: "rgba(0, 0, 0, 0.6)",
  qrFg: "#000000",
  qrBg: "#FFFFFF",
  toast: "#26272C",
  onToast: "#F2EFE8",
};

export const lightColors: ColorTokens = {
  bg: "#F6F3EC",
  bar: "#FBFAF6",
  surface: "#FFFFFF",
  surfaceRaised: "#F1EDE4",
  fill: "#ECE7DC",
  border: "#E4DFD4",
  borderField: "#8A8376",
  text: "#16171A",
  textMuted: "#67625A",
  textDisabled: "#A39C8F",
  accent: "#85662F",
  accentTint: "#F1E8D6",
  accentOnTint: "#6E5222",
  primary: "#16171A",
  onPrimary: "#D4B483",
  success: "#1A6E3F",
  successTint: "#E1F2E7",
  warning: "#8A5A00",
  warningTint: "#FBEFD2",
  danger: "#B3261E",
  dangerTint: "#FBE4E1",
  onDanger: "#FFFFFF",
  ai: "#1B6573",
  aiTint: "#DCEFF2",
  aiBorder: "#3F8995",
  scrim: "rgba(15, 16, 18, 0.4)",
  qrFg: "#000000",
  qrBg: "#FFFFFF",
  toast: "#16171A",
  onToast: "#F2EFE8",
};

/**
 * Fixed colors of the full-screen code (M-ORD-04, DESIGN.md 7.10): the screen
 * is white in any theme, so its text and page dots do not follow the theme.
 */
export const codeScreenColors = {
  background: "#FFFFFF",
  code: "#000000",
  text: "#16171A",
  textMuted: "#67625A",
  dotActive: "#16171A",
  dotInactive: "#CFC8BA",
} as const;

/** Scanner frame corners: dark-theme `accent` regardless of theme (7.10). */
export const scannerFrameColor = darkColors.accent;
