import {
  contentSwap,
  createLoadingGate,
  type ContentSwap,
  type LoadingGate,
} from "@adclub/ui-core";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Animated } from "react-native";
import { animateTo } from "./motion";
import { useTheme } from "./theme";

/**
 * Loading without flicker in the app (DESIGN 7.6 «Загрузка без мигания»,
 * D-069, TASK-032.A). The rule — the delay before an indicator, its
 * minimum, «only the last load» — is `createLoadingGate` of
 * `@adclub/ui-core`, the same one the web uses; this file only turns it into
 * React hooks. No screen keeps a timer or a number of its own.
 */

export interface LoadingGateHandle {
  /** The loading indicator is on screen (after the delay, for at least its minimum). */
  indicator: boolean;
  /** A load waits for its answer, or its answer for its moment. */
  pending: boolean;
  begin: LoadingGate["begin"];
  settle: LoadingGate["settle"];
  cancel: LoadingGate["cancel"];
}

/** One place of a screen that waits; answers are applied through `settle`, never directly. */
export function useLoadingGate(): LoadingGateHandle {
  const [gate] = useState(() => createLoadingGate());
  const indicator = useSyncExternalStore(gate.subscribe, () => gate.indicator);
  const pending = useSyncExternalStore(gate.subscribe, () => gate.pending);
  useEffect(() => () => gate.dispose(), [gate]);
  return useMemo(
    () => ({ indicator, pending, begin: gate.begin, settle: gate.settle, cancel: gate.cancel }),
    [gate, indicator, pending],
  );
}

/** The indicator of something simply busy (a button, a first load): after the delay, then its minimum. */
export function useDelayedIndicator(active: boolean): boolean {
  const { indicator, begin, settle } = useLoadingGate();
  useEffect(() => {
    if (!active) return;
    const ticket = begin();
    return () => settle(ticket, () => undefined);
  }, [active, begin, settle]);
  return indicator;
}

/** How new content takes the place of the old one under the system's «Уменьшить движение». */
export function useContentSwap(): ContentSwap {
  const { reduceMotion } = useTheme();
  return useMemo(() => contentSwap(reduceMotion), [reduceMotion]);
}

/**
 * The opacity of content that may be reloaded (`Screen`): dimmed while a
 * reload is seen (`dim`), and faded in from the dimmed opacity when other
 * content takes its place (`swapKey` changes — another sort, another list).
 * The first content of a screen is not faded here: the screen's own
 * transition brings it. Under «Уменьшить движение» the opacity is only set.
 */
export function useContentOpacity(dim: boolean, swapKey: unknown): Animated.Value {
  const swap = useContentSwap();
  const [opacity] = useState(() => new Animated.Value(1));
  const seen = useRef<{ key: unknown } | null>(null);
  const dimmed = useRef(false);

  // Another answer: from the dimmed opacity to full.
  useEffect(() => {
    const first = seen.current === null;
    if (!first && Object.is(seen.current?.key, swapKey)) return;
    seen.current = { key: swapKey };
    if (first || !swap.fades) {
      opacity.setValue(dimmed.current ? swap.fromOpacity : 1);
      return;
    }
    opacity.setValue(swap.fromOpacity);
    animate(opacity, dimmed.current ? swap.fromOpacity : 1, swap).start();
  }, [swapKey, swap, opacity]);

  // A reload that is seen dims what stays; its end brings it back.
  useEffect(() => {
    if (dimmed.current === dim) return;
    dimmed.current = dim;
    const target = dim ? swap.fromOpacity : 1;
    if (!swap.fades) {
      opacity.setValue(target);
      return;
    }
    animate(opacity, target, swap).start();
  }, [dim, swap, opacity]);

  return opacity;
}

/**
 * An opacity that goes to `target` by the swap rule whenever it changes,
 * starting at `initial`: a skeleton that appears after the delay, content
 * that appears after its skeleton. Set at once under «Уменьшить движение».
 */
export function useFadeTo(target: number, initial: number): Animated.Value {
  const swap = useContentSwap();
  const [opacity] = useState(() => new Animated.Value(swap.fades ? initial : target));
  useEffect(() => {
    if (!swap.fades) {
      opacity.setValue(target);
      return;
    }
    const animation = animate(opacity, target, swap);
    animation.start();
    return () => animation.stop();
  }, [target, swap, opacity]);
  return opacity;
}

/** The swap as a plan of the one rule of motion: a fade, nothing travels. */
function animate(value: Animated.Value, toValue: number, swap: ContentSwap) {
  return animateTo(value, toValue, {
    durationMs: swap.durationMs,
    easing: swap.easing,
    fades: true,
    moves: false,
  });
}
