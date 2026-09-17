/**
 * Platform-neutral core of the design system (TASK-075, ARCHITECTURE 4.10):
 * tokens of DESIGN.md 7, theme modes, contrast rules and the pure logic of
 * components. `@adclub/ui` (web) and `apps/mobile` build their components on it.
 */
export {
  codeScreenColors,
  darkColors,
  lightColors,
  scannerFrameColor,
  type ColorToken,
  type ColorTokens,
} from "./tokens/colors";
export {
  fontFamily,
  fontScale,
  typography,
  type FontWeight,
  type TextStyleToken,
  type TypographyToken,
} from "./tokens/typography";
export { breakpoints, icon, layout, qr, size, space } from "./tokens/layout";
export { floatShadow, line, motion, radius } from "./tokens/shape";
export {
  createThemeModeStore,
  defaultThemeMode,
  isThemeMode,
  resolveThemeName,
  themeModes,
  themes,
  type Theme,
  type ThemeMode,
  type ThemeModeStorage,
  type ThemeModeStore,
  type ThemeName,
} from "./theme";
export {
  contrastExceptions,
  contrastPairs,
  contrastRatio,
  findContrastViolations,
  NON_TEXT_MIN_CONTRAST,
  relativeLuminance,
  TEXT_MIN_CONTRAST,
  type ContrastException,
  type ContrastPair,
  type ContrastViolation,
} from "./contrast";
export {
  AI_PILOT_ACCESSIBILITY_LABEL,
  aiPilotButtonColorway,
  aiPilotStates,
  bannerTones,
  clampQuantity,
  compatibilityMarks,
  createPressGuard,
  createQrMatrix,
  formatOrderCode,
  HIDDEN_ORDER_CODE,
  isPressBlocked,
  nextBlinkDelay,
  ORDER_CODE_LENGTH,
  orderStatusGroups,
  qrPath,
  quantityControls,
  sanitizeOrderCode,
  selectAiPilotState,
  shouldAiPilotBlink,
  splitOrderCode,
  toneColors,
  type AiPilotActivity,
  type AiPilotColorway,
  type AiPilotState,
  type BannerTone,
  type Compatibility,
  type IconName,
  type OrderStatusGroup,
  type PressGuard,
  type Tone,
  type ToneColors,
} from "./logic";
export { aiPilotSvg, brandSvg, type BrandSvgName } from "./brand/brand-svg";
