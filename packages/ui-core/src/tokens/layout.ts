/** Spacing, sizes and grid — DESIGN.md 7.5, 7.7, 7.8, 7.10. */

/** Spacing scale: 4 · 8 · 12 · 16 · 20 · 24 · 32 · 40 · 48. */
export const space = {
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
} as const;

export const layout = {
  /** Mobile screen side padding. */
  screenPadding: 16,
  /** Between screen blocks. */
  blockGap: 24,
  /** Inside a card: 12–16. */
  cardPaddingS: 12,
  cardPadding: 16,
} as const;

export const size = {
  /** Minimum touch target, even when the element is visually smaller. */
  touchTarget: 48,
  button: { l: 52, m: 44, s: 36 },
  field: 48,
  search: 48,
  chip: 36,
  segments: 40,
  switch: { width: 52, height: 32 },
  checkbox: 24,
  radio: 24,
  quantityButton: 44,
  /** Order code entry cells (S-SCAN-02). */
  codeCell: { width: 48, height: 64 },
  keypadKey: 64,
  tabBar: 64,
  topBar: 56,
  /** AI Pilot / Scanner button in the middle of the tab bar. */
  centerTab: { diameter: 60, lift: 20, ring: 4, figure: 40 },
  sheetHandle: { width: 36, height: 4 },
  dialogMaxWidth: 320,
  emptyStateIcon: 48,
  resultIcon: 48,
  avatar: 32,
  thumbnail: 72,
  tableRow: 48,
  sidebar: 240,
  contentMaxWidth: 1200,
  roundButton: 56,
} as const;

/** Icon sizes (Tabler, 24 grid): 16 · 20 · 24; tab bar — 24. */
export const icon = {
  s: 16,
  m: 20,
  l: 24,
  strokeWidth: 1.75,
} as const;

/** Supplier cabinet breakpoints (web): < 600 one column, 600–1023 two, >= 1024 sidebar and tables. */
export const breakpoints = {
  twoColumns: 600,
  sidebar: 1024,
} as const;

export const qr = {
  /** QR square in the order card (M-ORD-03). */
  card: 176,
  /** "Ready for pickup" order. */
  cardReady: 208,
  /** White padding inside the QR block. */
  padding: 12,
  /** Full screen: screen width − 48, at most 360. */
  fullScreenInset: 48,
  fullScreenMax: 360,
  /** Quiet zone, in modules. */
  quietZoneModules: 4,
  errorCorrection: "M",
  /** Code block before the order is accepted. */
  pendingOpacity: 0.3,
} as const;
