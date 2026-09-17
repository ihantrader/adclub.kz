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

export const line = {
  width: 1,
  /** Focus ring (web and keyboard): 2 px `accent`, 2 px offset (7.7). */
  focusWidth: 2,
  focusOffset: 2,
  /** Focused / invalid field border. */
  fieldActiveWidth: 2,
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
  /** Skeleton shimmer period. */
  skeleton: 1200,
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
