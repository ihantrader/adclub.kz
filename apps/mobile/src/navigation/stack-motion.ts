import type { ScreenTransition } from "@adclub/ui-core";
import type { NativeStackNavigationOptions } from "@react-navigation/native-stack";

/**
 * How a native stack turns the rule of screen transitions into its options.
 * The rule is `screenTransition` of `@adclub/ui-core` (DESIGN 7.6: the
 * platform's own transitions, 250 ms; a fade with «Уменьшить движение»); this
 * is the only place that maps it, and **every stack of the app takes its
 * options from `useStackScreenOptions`** (`use-stack-screen-options.ts`) — so
 * the catalog, the garage, the first run and the steps of choosing a car all
 * move the same way, and none of them can forget the system's reduced motion.
 *
 * Pure, so a test can hold it to the rule without React Native.
 */
export function stackOptionsFor(transition: ScreenTransition): NativeStackNavigationOptions {
  return {
    headerShown: false,
    // «default» is the platform's own push and pop: a slide from the side on
    // iOS, the system's transition on Android. Neither can be told a
    // duration, and neither is replaced by a fade by the system itself when
    // the person asked for less motion — hence the explicit «fade».
    animation: transition.kind === "fade" ? "fade" : "default",
    // Only a fade can be given a length (iOS; its own default is 500 ms).
    animationDuration: transition.durationMs,
  };
}
