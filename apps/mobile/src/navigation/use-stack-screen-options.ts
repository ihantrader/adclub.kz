import { screenTransition } from "@adclub/ui-core";
import type { NativeStackNavigationOptions } from "@react-navigation/native-stack";
import { useMemo } from "react";
import { useTheme } from "../design-system";
import { stackOptionsFor } from "./stack-motion";

/** The options of every stack of the app: the one rule of screen transitions under the system's «Уменьшить движение». */
export function useStackScreenOptions(): NativeStackNavigationOptions {
  const { reduceMotion } = useTheme();
  return useMemo(() => stackOptionsFor(screenTransition(reduceMotion)), [reduceMotion]);
}
