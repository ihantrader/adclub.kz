/** Shape, lines, shadows and motion — DESIGN.md 7.6. */

export const radius = {
  /** Skeleton blocks, small marks inside a row, checkbox. */
  xs: 2,
  /** Buttons, fields, chips, status badges, bubbles. */
  s: 4,
  /** Cards, photos, banners. */
  m: 6,
  /** Sheets (top corners), dialogs. */
  l: 12,
  /** Avatars, AI Pilot button, switch. */
  full: 9999,
} as const;

/**
 * Lines (DESIGN.md 7.6, D-068). Row dividers and card borders are the thinnest
 * line of the screen — `hairline` (1 px on the web; the app uses
 * `StyleSheet.hairlineWidth`, a single physical pixel). Fields, secondary
 * buttons and chips — 1 px, active and invalid fields included.
 */
export const line = {
  width: 1,
  /** Web value of the hairline; the app replaces it with `StyleSheet.hairlineWidth`. */
  hairline: 1,
  /** Focus ring (web and keyboard): 2 px `accent`, 2 px offset (7.7) — an accessibility requirement. */
  focusWidth: 2,
  focusOffset: 2,
} as const;

/** Shadow of floating elements (sheet, dialog, toast): none in the dark theme. */
export const floatShadow = {
  dark: null,
  light: {
    offsetY: 8,
    blur: 24,
    color: "rgba(15, 16, 18, 0.12)",
    css: "0 8px 24px rgba(15, 16, 18, 0.12)",
  },
} as const;

export const motion = {
  /** Press, toggles, state changes. */
  fast: 150,
  /** Sheets and transitions. */
  slow: 250,
  /** "Deceleration at the end". */
  easing: "cubic-bezier(0, 0, 0.2, 1)",
  /**
   * The same curve as numbers, for the clients that cannot read a CSS string
   * (React Native's `Easing.bezier`). A test keeps the two in step, so there
   * is one curve for the web and for the app.
   */
  bezier: [0, 0, 0.2, 1] as const,
  /** Skeleton shimmer period. */
  skeleton: 1200,
  /** A loading indicator appears only when waiting is longer than this (D-069). */
  loadingDelay: 300,
  /** A loading indicator that has appeared stays at least this long (D-069). */
  loadingMinVisible: 500,
  /** Opacity of content that stays on screen under the refresh line (D-069). */
  loadingDimOpacity: 0.5,
  /** Toast lifetime. */
  toast: 4000,
  /** Green check after a person confirms AI data (7.9). */
  confirmedCheck: 1000,
  /** AI Pilot blinks every 4–6 s in the idle state (DESIGN.md 6). */
  blinkMin: 4000,
  blinkMax: 6000,
  blinkDuration: 150,
  /** Pressed primary/secondary button: darken by 12 %. */
  pressedDarken: 0.12,
} as const;
