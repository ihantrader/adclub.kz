import {
  breakpoints,
  fontFamily,
  icon,
  line,
  motion,
  radius,
  size,
  space,
  themes,
  typography,
  type ColorTokens,
  type Theme,
  type TypographyToken,
} from "@adclub/ui-core";

/** `surfaceRaised` → `surface-raised`. */
export function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/** CSS custom property of a color token: `var(--ac-color-surface-raised)`. */
export function colorVar(token: keyof ColorTokens): string {
  return `var(--ac-color-${kebab(token)})`;
}

export function typographyClass(token: TypographyToken): string {
  return `ac-text-${kebab(token)}`;
}

function block(selector: string, declarations: [string, string | number][]): string {
  const body = declarations.map(([name, value]) => `  ${name}: ${value};`).join("\n");
  return `${selector} {\n${body}\n}\n`;
}

const px = (value: number) => `${value}px`;

function themeDeclarations(theme: Theme): [string, string][] {
  return [
    ["color-scheme", theme.name],
    ...Object.entries(theme.colors).map(([token, value]): [string, string] => [
      `--ac-color-${kebab(token)}`,
      value.toLowerCase(),
    ]),
    ["--ac-float-shadow", theme.floatShadow?.css ?? "none"],
  ];
}

/**
 * The generated `src/styles/theme.css`: every DESIGN.md 7 token as a CSS
 * custom property, both themes and the typography classes. The file is
 * compared with this output by `theme-css.test.ts`; regenerate it with
 * `pnpm --filter @adclub/ui test -u`.
 */
export function buildThemeCss(): string {
  const shared: [string, string | number][] = [
    ["--ac-font-family", `${fontFamily.name}, ${fontFamily.webFallback}`],
    ...Object.entries(space).map(([step, value]): [string, string] => [
      `--ac-space-${step}`,
      px(value),
    ]),
    ...Object.entries(radius).map(([name, value]): [string, string] => [
      `--ac-radius-${name}`,
      px(value),
    ]),
    ["--ac-line", px(line.width)],
    ["--ac-focus-width", px(line.focusWidth)],
    ["--ac-focus-offset", px(line.focusOffset)],
    ["--ac-touch-target", px(size.touchTarget)],
    ["--ac-button-l", px(size.button.l)],
    ["--ac-button-m", px(size.button.m)],
    ["--ac-button-s", px(size.button.s)],
    ["--ac-field", px(size.field)],
    ["--ac-chip", px(size.chip)],
    ["--ac-segments", px(size.segments)],
    ["--ac-switch-width", px(size.switch.width)],
    ["--ac-switch-height", px(size.switch.height)],
    ["--ac-checkbox", px(size.checkbox)],
    ["--ac-radio", px(size.radio)],
    ["--ac-quantity-button", px(size.quantityButton)],
    ["--ac-code-cell-width", px(size.codeCell.width)],
    ["--ac-code-cell-height", px(size.codeCell.height)],
    ["--ac-keypad-key", px(size.keypadKey)],
    ["--ac-tab-bar", px(size.tabBar)],
    ["--ac-top-bar", px(size.topBar)],
    ["--ac-center-tab", px(size.centerTab.diameter)],
    ["--ac-center-tab-lift", px(size.centerTab.lift)],
    ["--ac-center-tab-ring", px(size.centerTab.ring)],
    ["--ac-dialog-max-width", px(size.dialogMaxWidth)],
    ["--ac-empty-icon", px(size.emptyStateIcon)],
    ["--ac-table-row", px(size.tableRow)],
    ["--ac-sidebar", px(size.sidebar)],
    ["--ac-content-max-width", px(size.contentMaxWidth)],
    ["--ac-icon-s", px(icon.s)],
    ["--ac-icon-m", px(icon.m)],
    ["--ac-icon-l", px(icon.l)],
    ["--ac-motion-fast", `${motion.fast}ms`],
    ["--ac-motion-slow", `${motion.slow}ms`],
    ["--ac-motion-easing", motion.easing],
    ["--ac-motion-skeleton", `${motion.skeleton}ms`],
    ["--ac-pressed-darken", String(1 - motion.pressedDarken)],
    ["--ac-breakpoint-two-columns", px(breakpoints.twoColumns)],
    ["--ac-breakpoint-sidebar", px(breakpoints.sidebar)],
  ];

  const typographyRules = Object.entries(typography).map(([token, style]) =>
    block(`.${typographyClass(token as TypographyToken)}`, [
      ["font-size", px(style.fontSize)],
      ["line-height", px(style.lineHeight)],
      ["font-weight", style.fontWeight],
      ...(style.tabularNums
        ? ([["font-variant-numeric", "tabular-nums"]] as [string, string][])
        : []),
    ]),
  );

  return [
    "/* Generated from @adclub/ui-core tokens (DESIGN.md 7) by src/theme/theme-css.ts — do not edit.\n   Regenerate: pnpm --filter @adclub/ui test -u */\n",
    block(":root", shared),
    // Light is the web default (DESIGN.md 7.3); `data-theme` switches without reload.
    block(':root,\n:root[data-theme="light"]', themeDeclarations(themes.light)),
    block(':root[data-theme="dark"]', themeDeclarations(themes.dark)),
    ...typographyRules,
  ].join("\n");
}
