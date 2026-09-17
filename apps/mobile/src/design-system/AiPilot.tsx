import {
  AI_PILOT_ACCESSIBILITY_LABEL,
  aiPilotSvg,
  motion,
  nextBlinkDelay,
  shouldAiPilotBlink,
  type AiPilotColorway,
  type AiPilotState,
} from "@adclub/ui-core";
import { useEffect, useState } from "react";
import { Animated, View } from "react-native";
import { SvgXml } from "react-native-svg";
import { useTheme } from "./theme";

export interface AiPilotProps {
  state: AiPilotState;
  colorway: AiPilotColorway;
  size: number;
  /** Screen reader name; omit when a parent already names the control. */
  accessibilityLabel?: string | null;
}

/**
 * Closed eyes over the idle face (same 64 grid and eye positions as
 * design/brand/assistant.py): the eyes are covered with the head color and
 * drawn as short lines in the face color.
 */
function blinkSvg(colorway: AiPilotColorway): string {
  const [head, face] =
    colorway === "on-champagne" ? ["#0F1012", "#D4B483"] : ["#D4B483", "#0F1012"];
  const eye = (cx: number) =>
    `<circle cx="${cx}" cy="38" r="5.2" fill="${head}"/>` +
    `<path d="M${cx - 4.2} 38.6h8.4" stroke="${face}" stroke-width="2.4" stroke-linecap="round"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${eye(25)}${eye(39)}</svg>`;
}

/**
 * AI Pilot character from design/brand/assistant (DESIGN.md 6): five states,
 * two colorways, a short blink every 4–6 s while idle, a 150 ms fade
 * between states; no animation with "reduce motion".
 */
export function AiPilot({
  state,
  colorway,
  size,
  accessibilityLabel = AI_PILOT_ACCESSIBILITY_LABEL.ru,
}: AiPilotProps) {
  const { reduceMotion } = useTheme();
  const [blinking, setBlinking] = useState(false);
  const [opacity] = useState(() => new Animated.Value(1));
  const blinks = shouldAiPilotBlink(state, reduceMotion);

  useEffect(() => {
    if (!blinks) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => {
        setBlinking(true);
        timer = setTimeout(() => {
          setBlinking(false);
          schedule();
        }, motion.blinkDuration);
      }, nextBlinkDelay());
    };
    schedule();
    return () => {
      clearTimeout(timer);
      setBlinking(false);
    };
  }, [blinks]);

  useEffect(() => {
    if (reduceMotion) return;
    opacity.setValue(0.4);
    Animated.timing(opacity, { toValue: 1, duration: motion.fast, useNativeDriver: true }).start();
  }, [state, opacity, reduceMotion]);

  return (
    <View
      accessible={accessibilityLabel !== null}
      accessibilityRole={accessibilityLabel !== null ? "image" : undefined}
      accessibilityLabel={accessibilityLabel ?? undefined}
      style={{ width: size, height: size }}
    >
      <Animated.View style={{ opacity }}>
        <SvgXml xml={aiPilotSvg[state][colorway]} width={size} height={size} />
      </Animated.View>
      {blinking && blinks && (
        <View style={{ position: "absolute", inset: 0 }} pointerEvents="none">
          <SvgXml xml={blinkSvg(colorway)} width={size} height={size} />
        </View>
      )}
    </View>
  );
}
