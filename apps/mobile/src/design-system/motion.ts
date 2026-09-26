import { motionPlan, type MotionPlan, type MotionRole } from "@adclub/ui-core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing } from "react-native";
import { useTheme } from "./theme";

/**
 * How things move in the app, in one place (TASK-028.A, ARCHITECTURE 4.39).
 * The rule itself is `motionPlan` of `@adclub/ui-core` — durations, the curve
 * «замедление в конце», and what may travel when the system asks for reduced
 * motion. This file only turns a plan into React Native: no component keeps
 * a number, a curve or an `if (reduceMotion)` of its own.
 */

/** The plan of a role under the system's «Уменьшить движение». */
export function useMotionPlan(role: MotionRole): MotionPlan {
  const { reduceMotion } = useTheme();
  return useMemo(() => motionPlan(role, reduceMotion), [role, reduceMotion]);
}

/** The curve of a plan as an easing function of `Animated.timing`. */
export function planEasing(plan: MotionPlan): (value: number) => number {
  return Easing.bezier(...plan.easing);
}

/** Moves an animated value to `toValue` the way the plan says. */
export function animateTo(
  value: Animated.Value,
  toValue: number,
  plan: MotionPlan,
): Animated.CompositeAnimation {
  return Animated.timing(value, {
    toValue,
    duration: plan.durationMs,
    easing: planEasing(plan),
    useNativeDriver: true,
  });
}

/**
 * The appearing and disappearing of something over the screen — a sheet, a
 * dialog, a toast. `progress` goes 0 → 1 → 0 by the plan, and the thing stays
 * mounted (`mounted`) until it has finished going away, so closing is the
 * same movement backwards and not a jump. `onDismissed` is called once, when
 * a thing that was shown has finished disappearing.
 *
 * `mounted` follows `visible` at once when it opens, so an overlay can never
 * refuse to open; only the closing waits.
 */
export function useOverlayTransition(
  visible: boolean,
  plan: MotionPlan,
  onDismissed?: () => void,
): { progress: Animated.Value; mounted: boolean } {
  const [progress] = useState(() => new Animated.Value(0));
  /**
   * Keeps the overlay on screen for one more animation after `visible` has
   * gone false, so closing is not a jump. It is raised on the frame after the
   * overlay is asked for and lowered when the closing animation ends.
   */
  const [held, setHeld] = useState(false);
  const wasShown = useRef(false);
  const dismissed = useRef(onDismissed);
  useEffect(() => {
    dismissed.current = onDismissed;
  });

  useEffect(() => {
    let animation: Animated.CompositeAnimation | null = null;
    /*
     * A frame later, not right now: a modal mounts its content after this
     * effect, and the views the value was attached to before are detached
     * then — and detaching an animated value stops whatever is driving it
     * (`AnimatedValue.__detach`). Started in the same tick, the opening
     * animation was killed a few frames in and the overlay stayed off screen.
     */
    const frame = requestAnimationFrame(() => {
      if (visible) {
        wasShown.current = true;
        setHeld(true);
      }
      animation = animateTo(progress, visible ? 1 : 0, plan);
      animation.start(({ finished }) => {
        // Unmount only after the closing animation has played to the end.
        if (!finished || visible) return;
        setHeld(false);
        if (wasShown.current) {
          wasShown.current = false;
          dismissed.current?.();
        }
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      animation?.stop();
    };
  }, [visible, progress, plan]);

  return { progress, mounted: visible || held };
}

/**
 * «Закрыть, потом идти»: an action that belongs to a closing overlay runs
 * when the overlay has finished going away, not at the same moment. A sheet
 * that slides down while the screen behind it is being pushed shows two
 * movements at once, and a modal window stays over the new screen until it
 * is gone — so the push would play out unseen underneath it.
 *
 * `after(action)` remembers the action, `onDismissed` (given to the sheet or
 * the dialog) runs it once and forgets it. `visible` is whether the overlay
 * is open: opening it again forgets an action left over from a closing that
 * was interrupted, so it can never run at some later, unrelated dismissal.
 */
export function useAfterDismiss(visible: boolean): {
  after: (action: () => void) => void;
  onDismissed: () => void;
} {
  const pending = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (visible) pending.current = null;
  }, [visible]);
  const after = useCallback((action: () => void) => {
    pending.current = action;
  }, []);
  const onDismissed = useCallback(() => {
    const action = pending.current;
    pending.current = null;
    action?.();
  }, []);
  return useMemo(() => ({ after, onDismissed }), [after, onDismissed]);
}
