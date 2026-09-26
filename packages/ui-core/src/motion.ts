import { motion } from "./tokens/shape";

/**
 * The one rule of motion (DESIGN 7.6 «Движение», TASK-028.A).
 *
 * «150 мс — нажатие, переключатели, смена состояний; 250 мс — шторки и
 * переходы (платформенные). Кривая — „замедление в конце“. При „Уменьшить
 * движение“ — только смена прозрачности.»
 *
 * Every thing that moves in an app asks for its plan here — by the role it
 * plays, and whether the system asked for reduced motion — and never keeps
 * numbers of its own. So a sheet, a dialog, a screen transition and a toast
 * cannot end up with three different curves, and «Уменьшить движение» is one
 * decision made in one table instead of an `if` remembered in every screen.
 *
 * Reduced motion keeps the change and drops the travel: what slid now fades
 * (an opacity change is allowed), nothing slides, scales or repeats.
 *
 * Presses are not a role on purpose: a pressed state is the platform's own
 * feedback (a ripple, a dimmed row) and is instant, which is quicker than the
 * 150 ms the rule allows — see ARCHITECTURE 4.39.
 */
export type MotionRole =
  /** A toggle, a colour or a selection changing. */
  | "state"
  /** Something appearing on a screen: a toast, content after its skeleton. */
  | "appear"
  /** A confirmation over the screen: only a fade, it never travels. */
  | "dialog"
  /** A bottom sheet: the scrim fades, the sheet travels from the bottom edge. */
  | "sheet"
  /** A move from one screen to another. */
  | "screen";

export interface MotionPlan {
  durationMs: number;
  /** The control points of the curve `motion.easing` (deceleration at the end). */
  easing: readonly [number, number, number, number];
  /** Opacity may change. */
  fades: boolean;
  /** Position or size may change — a slide, a travel. Never with reduced motion. */
  moves: boolean;
}

/** What each role does when motion is allowed. */
const NORMAL: Record<MotionRole, { durationMs: number; fades: boolean; moves: boolean }> = {
  state: { durationMs: motion.fast, fades: true, moves: true },
  appear: { durationMs: motion.fast, fades: true, moves: false },
  dialog: { durationMs: motion.fast, fades: true, moves: false },
  sheet: { durationMs: motion.slow, fades: false, moves: true },
  screen: { durationMs: motion.slow, fades: false, moves: true },
};

export function motionPlan(role: MotionRole, reduceMotion: boolean): MotionPlan {
  const normal = NORMAL[role];
  return {
    durationMs: normal.durationMs,
    easing: motion.bezier,
    // The duration stays: a change of opacity over 150 or 250 ms is the whole
    // point of «только смена прозрачности».
    fades: reduceMotion ? true : normal.fades,
    moves: reduceMotion ? false : normal.moves,
  };
}

/**
 * How a bottom sheet appears and disappears (DESIGN 7.6, 7.7): the scrim is
 * a layer **under** the sheet, so it only changes opacity — it never travels
 * with it — while the sheet itself slides up from the bottom over
 * `motion.slow` with «замедление в конце». With the system «Уменьшить
 * движение» on, nothing moves: both the scrim and the sheet only fade.
 *
 * One rule for every sheet of every client, so a platform's own modal
 * animation (which moves the whole window, scrim included) is never used.
 */
export interface SheetMotion {
  durationMs: number;
  /** The scrim always appears and disappears by opacity alone. */
  scrimFades: boolean;
  /** Whether the sheet travels from the bottom edge. */
  sheetSlides: boolean;
  /** The sheet fades instead of sliding when motion is reduced. */
  sheetFades: boolean;
}

export function sheetMotion(reduceMotion: boolean): SheetMotion {
  const plan = motionPlan("sheet", reduceMotion);
  return {
    durationMs: plan.durationMs,
    scrimFades: true,
    sheetSlides: plan.moves,
    sheetFades: plan.fades,
  };
}

/**
 * How a move from one screen to another looks. DESIGN says transitions are
 * the platform's own (a push slides in from the side on iOS, the system's
 * transition on Android); with «Уменьшить движение» they are a fade. The
 * platform decides the length of its own push, and 250 ms is what the fade is
 * given where a client can set it.
 */
export interface ScreenTransition {
  kind: "platform" | "fade";
  durationMs: number;
}

export function screenTransition(reduceMotion: boolean): ScreenTransition {
  const plan = motionPlan("screen", reduceMotion);
  return { kind: plan.moves ? "platform" : "fade", durationMs: plan.durationMs };
}
