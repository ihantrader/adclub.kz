import { motionPlan } from "./motion";
import { motion } from "./tokens/shape";

/**
 * The one rule of loading (DESIGN 7.6 «Загрузка без мигания», D-069,
 * TASK-032.A) — the continuation of `motionPlan` for what is waited for.
 *
 * - A loading indicator (a skeleton, the refresh line, a spinner on a
 *   button) appears only when waiting is longer than `showAfterMs`; a quick
 *   answer is shown at once, with no indicator at all.
 * - An indicator that has appeared stays at least `minVisibleMs`: the answer
 *   that arrives in the meantime is held until then, never longer — so an
 *   indicator never blinks on and off.
 * - Of several loads one after another only the last is shown.
 * - On a reload the previous content stays on screen, dimmed to
 *   `dimOpacity` under the refresh line, and is replaced by the new one with
 *   a fade (`contentSwap`); a skeleton is only for the first load of a screen.
 *
 * The web (`@adclub/ui`) and the app (`apps/mobile/src/design-system`) wrap
 * `createLoadingGate` in a hook of their own and never keep a number of
 * their own.
 */
export const loadingRule = {
  showAfterMs: motion.loadingDelay,
  minVisibleMs: motion.loadingMinVisible,
  dimOpacity: motion.loadingDimOpacity,
} as const;

/**
 * How new content takes the place of the old one: a fade of `motion.fast`
 * from the dimmed opacity. With the system «Уменьшить движение» there is no
 * fade at all — the content is simply replaced. This is narrower than the
 * general reduced-motion rule (an opacity change is allowed): DESIGN 7.6
 * says it of loading in so many words, and a swap that is not animated
 * cannot read as a flicker either.
 */
export interface ContentSwap {
  fades: boolean;
  durationMs: number;
  easing: readonly [number, number, number, number];
  /** Where the new content starts from: the opacity the old one was dimmed to. */
  fromOpacity: number;
}

export function contentSwap(reduceMotion: boolean): ContentSwap {
  const plan = motionPlan("appear", reduceMotion);
  return {
    fades: !reduceMotion,
    durationMs: plan.durationMs,
    easing: plan.easing,
    fromOpacity: loadingRule.dimOpacity,
  };
}

/** A clock and timers; the platform's own by default, a fake one in tests. */
export interface LoadingClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemClock: LoadingClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * One place that waits: a list, a card, a button. A load `begin`s and gets
 * a ticket; when its answer is there, `settle(ticket, show)` — `show` puts
 * the answer on screen at the moment the rule allows. Only the latest ticket
 * counts: an earlier load that answers late is ignored, and an answer held
 * for the indicator's minimum is dropped when a newer load begins.
 */
export interface LoadingGate {
  /** A load starts and supersedes any earlier one whose answer is not on screen yet. */
  begin(): number;
  /**
   * The answer of `ticket` (data or an error) is there. `show` runs at once
   * when the indicator never appeared, else when the indicator has been on
   * screen `minVisibleMs` — in the same tick the indicator goes away.
   */
  settle(ticket: number, show: () => void): void;
  /** The load is abandoned (nothing more to wait for): nothing is shown. */
  cancel(): void;
  /** Whether the loading indicator is on screen now. */
  readonly indicator: boolean;
  /** Whether a load is waiting for its answer, or its answer for its moment. */
  readonly pending: boolean;
  subscribe(listener: () => void): () => void;
  /** Stops the timers; the gate may begin again afterwards. */
  dispose(): void;
}

export function createLoadingGate(clock: LoadingClock = systemClock): LoadingGate {
  let ticket = 0;
  let pending = false;
  /** When the indicator appeared; `null` — it is not on screen. */
  let shownAt: number | null = null;
  let showTimer: unknown = null;
  let holdTimer: unknown = null;
  const listeners = new Set<() => void>();

  const emit = () => listeners.forEach((listener) => listener());
  const clearShow = () => {
    if (showTimer !== null) clock.clearTimeout(showTimer);
    showTimer = null;
  };
  const clearHold = () => {
    if (holdTimer !== null) clock.clearTimeout(holdTimer);
    holdTimer = null;
  };

  /** Takes the indicator away (running `show` first) once it has been seen long enough. */
  const finish = (show: (() => void) | null) => {
    clearShow();
    clearHold();
    if (shownAt === null) {
      pending = false;
      show?.();
      emit();
      return;
    }
    const remaining = loadingRule.minVisibleMs - (clock.now() - shownAt);
    const end = () => {
      holdTimer = null;
      shownAt = null;
      pending = false;
      show?.();
      emit();
    };
    if (remaining <= 0) end();
    else holdTimer = clock.setTimeout(end, remaining);
  };

  return {
    begin() {
      ticket += 1;
      pending = true;
      // An answer held for the indicator's minimum is no longer the one asked for.
      clearHold();
      if (shownAt === null && showTimer === null) {
        showTimer = clock.setTimeout(() => {
          showTimer = null;
          shownAt = clock.now();
          emit();
        }, loadingRule.showAfterMs);
      }
      emit();
      return ticket;
    },
    settle(settled, show) {
      if (settled !== ticket || !pending || holdTimer !== null) return;
      finish(show);
    },
    cancel() {
      if (!pending) return;
      ticket += 1;
      finish(null);
    },
    get indicator() {
      return shownAt !== null;
    },
    get pending() {
      return pending;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      clearShow();
      clearHold();
      shownAt = null;
      pending = false;
      ticket += 1;
    },
  };
}
