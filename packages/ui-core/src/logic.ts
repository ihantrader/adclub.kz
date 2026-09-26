import qrcode from "qrcode-generator";
import type { ColorToken } from "./tokens/colors";
import type { ThemeName } from "./theme";
import { qr } from "./tokens/layout";
import { motion } from "./tokens/shape";

// ---------------------------------------------------------------- order code

export const ORDER_CODE_LENGTH = 6;

/** Keeps digits only, at most six (typed or pasted into the code cells). */
export function sanitizeOrderCode(input: string): string {
  return input.replace(/\D/g, "").slice(0, ORDER_CODE_LENGTH);
}

/** "482915" → ["482", "915"]: groups of three (DESIGN.md 7.10). */
export function splitOrderCode(code: string): [string, string] {
  return [code.slice(0, 3), code.slice(3, 6)];
}

/** "482915" → "482 915"; a partial code keeps its groups ("4829" → "482 9"). */
export function formatOrderCode(code: string): string {
  return splitOrderCode(code)
    .filter((group) => group.length > 0)
    .join(" ");
}

/** Code hidden until the order is accepted (DES-4): "••• •••". */
export const HIDDEN_ORDER_CODE = "••• •••";

// ---------------------------------------------------------------- press guard

/**
 * Blocks repeated activation of an action while it is running (DESIGN.md 7.1,
 * SCREENS 2.1). The lock is taken synchronously, so a double click or a
 * repeated Enter in the same tick — before React re-renders the button as
 * "loading" — is ignored too.
 */
export interface PressGuard {
  /** Runs `action` unless one is already running; returns false when ignored. */
  run(action: () => unknown): boolean;
  isBusy(): boolean;
}

export function createPressGuard(onBusyChange?: (busy: boolean) => void): PressGuard {
  let busy = false;
  const release = () => {
    busy = false;
    onBusyChange?.(false);
  };
  return {
    isBusy: () => busy,
    run(action) {
      if (busy) return false;
      let result: unknown;
      try {
        result = action();
      } catch (error) {
        release();
        throw error;
      }
      if (result instanceof Promise) {
        busy = true;
        onBusyChange?.(true);
        result.then(release, release);
      }
      return true;
    },
  };
}

/** A button ignores presses while loading or disabled. */
export function isPressBlocked(state: { loading?: boolean; disabled?: boolean }): boolean {
  return Boolean(state.loading || state.disabled);
}

// ---------------------------------------------------------------- quantity

export function clampQuantity(value: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** "−" is disabled at the minimum (1), "+" at the maximum (DESIGN.md 7.7). */
export function quantityControls(value: number, min = 1, max = Number.MAX_SAFE_INTEGER) {
  return { canDecrease: value > min, canIncrease: value < max };
}

// ---------------------------------------------------------------- AI Pilot

export type AiPilotState = "idle" | "listening" | "thinking" | "happy" | "unsure";

export const aiPilotStates: readonly AiPilotState[] = [
  "idle",
  "listening",
  "thinking",
  "happy",
  "unsure",
];

/** `on-champagne` — graphite robot; `on-graphite` — champagne robot (DESIGN.md 6). */
export type AiPilotColorway = "on-champagne" | "on-graphite";

export interface AiPilotActivity {
  /** Voice input is in progress. */
  listening?: boolean;
  /** A request is being processed. */
  pending?: boolean;
  /** Outcome of the last answer, if any. */
  outcome?: "found" | "not-found" | "not-understood" | "unavailable" | null;
}

/**
 * The character's state (DESIGN.md 6): listening wins over thinking, an
 * in-flight request over the last outcome; no outcome — waiting.
 */
export function selectAiPilotState(activity: AiPilotActivity): AiPilotState {
  if (activity.listening) return "listening";
  if (activity.pending) return "thinking";
  switch (activity.outcome) {
    case "found":
      return "happy";
    case "not-found":
    case "not-understood":
    case "unavailable":
      return "unsure";
    default:
      return "idle";
  }
}

/**
 * Colorway of the character on the tab bar button: the button is `primary`
 * (champagne in the dark theme, graphite in the light one).
 */
export function aiPilotButtonColorway(theme: ThemeName): AiPilotColorway {
  return theme === "dark" ? "on-champagne" : "on-graphite";
}

/** Only the idle state blinks, and never with "reduce motion" on. */
export function shouldAiPilotBlink(state: AiPilotState, reduceMotion: boolean): boolean {
  return state === "idle" && !reduceMotion;
}

/** Next blink delay, 4–6 s; `random` is `Math.random`-like. */
export function nextBlinkDelay(random: () => number = Math.random): number {
  return Math.round(motion.blinkMin + (motion.blinkMax - motion.blinkMin) * random());
}

/** Screen reader name (DESIGN.md 6). */
export const AI_PILOT_ACCESSIBILITY_LABEL = {
  ru: "AI Pilot, помощник",
  kk: "AI Pilot, көмекші",
  en: "AI Pilot, assistant",
} as const;

// ---------------------------------------------------------------- statuses

export type Tone = "neutral" | "warning" | "accent" | "success" | "danger" | "ai";

export interface ToneColors {
  foreground: ColorToken;
  background: ColorToken;
}

export const toneColors: Record<Tone, ToneColors> = {
  neutral: { foreground: "textMuted", background: "fill" },
  warning: { foreground: "warning", background: "warningTint" },
  accent: { foreground: "accentOnTint", background: "accentTint" },
  success: { foreground: "success", background: "successTint" },
  danger: { foreground: "danger", background: "dangerTint" },
  ai: { foreground: "ai", background: "aiTint" },
};

/** Order status groups (DESIGN.md 7.8). Outcomes are neutral, never red. */
export type OrderStatusGroup = "waiting" | "needsReply" | "inProgress" | "ready" | "finished";

export const orderStatusGroups: Record<OrderStatusGroup, { tone: Tone; icon: IconName }> = {
  waiting: { tone: "neutral", icon: "clock" },
  needsReply: { tone: "warning", icon: "alertTriangle" },
  inProgress: { tone: "accent", icon: "progressCheck" },
  ready: { tone: "success", icon: "package" },
  finished: { tone: "neutral", icon: "archive" },
};

/** Compatibility marks (DESIGN.md 7.8): icon + color, always with text. */
export type Compatibility = "fits" | "missingParameter" | "doesNotFit" | "unknown";

export const compatibilityMarks: Record<Compatibility, { color: ColorToken; icon: IconName }> = {
  fits: { color: "success", icon: "circleCheck" },
  missingParameter: { color: "warning", icon: "alertTriangle" },
  doesNotFit: { color: "danger", icon: "circleX" },
  unknown: { color: "textMuted", icon: "helpCircle" },
};

export type BannerTone = "neutral" | "warning" | "danger";

export const bannerTones: Record<BannerTone, { background: ColorToken; icon: ColorToken }> = {
  neutral: { background: "fill", icon: "text" },
  warning: { background: "warningTint", icon: "warning" },
  danger: { background: "dangerTint", icon: "danger" },
};

/**
 * Semantic icon names used by the shared components; each platform maps them
 * to its Tabler package (`@tabler/icons-react` / `@tabler/icons-react-native`).
 */
export type IconName =
  | "alertTriangle"
  | "archive"
  | "arrowLeft"
  | "backspace"
  | "car"
  | "category"
  | "check"
  | "checklist"
  | "chevronDown"
  | "chevronRight"
  | "circleCheck"
  | "circleX"
  | "clock"
  | "contrast"
  | "copy"
  | "dots"
  | "fileSpreadsheet"
  | "helpCircle"
  | "info"
  | "language"
  | "lock"
  | "mapPin"
  | "minus"
  | "moon"
  | "myLocation"
  | "package"
  | "plus"
  | "progressCheck"
  | "receipt"
  | "refresh"
  | "scan"
  | "search"
  | "settings"
  | "sparkles"
  | "star"
  | "sun"
  | "tags"
  | "trash"
  | "user"
  | "wifiOff"
  | "x";

// ---------------------------------------------------------------- QR

/**
 * QR modules for `text` at error correction level M (DESIGN.md 7.10),
 * without the quiet zone; `true` — dark module. The content itself is defined
 * by the order-code contract (not here).
 */
export function createQrMatrix(text: string): boolean[][] {
  const code = qrcode(0, qr.errorCorrection);
  code.addData(text, "Byte");
  code.make();
  const count = code.getModuleCount();
  return Array.from({ length: count }, (_, row) =>
    Array.from({ length: count }, (_, col) => code.isDark(row, col)),
  );
}

/**
 * SVG path (one unit per module) of the dark modules, offset by the quiet
 * zone; the view box side is `modules + 2 * quietZone`.
 */
export function qrPath(matrix: boolean[][], quietZone: number = qr.quietZoneModules) {
  const parts: string[] = [];
  matrix.forEach((cells, row) => {
    let col = 0;
    while (col < cells.length) {
      if (!cells[col]) {
        col += 1;
        continue;
      }
      const start = col;
      while (col < cells.length && cells[col]) col += 1;
      parts.push(`M${start + quietZone} ${row + quietZone}h${col - start}v1h${start - col}z`);
    }
  });
  return { d: parts.join(""), viewBoxSize: matrix.length + quietZone * 2 };
}
