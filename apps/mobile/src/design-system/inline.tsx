import type { ColorToken, TypographyToken } from "@adclub/ui-core";
import { useRef, useState } from "react";
import { StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { DOT, NBSP, joinDot } from "../catalog/format";
import { Text } from "./text";

export interface DotLinePart {
  text: string;
  variant?: TypographyToken;
  color?: ColorToken;
}

export interface DotLineProps {
  /** The parts in order; empty ones are left out. */
  parts: readonly (string | DotLinePart | null | undefined | false)[];
  /** The variant and colour of a part that names none of its own. */
  variant?: TypographyToken;
  color?: ColorToken;
}

/**
 * Parts joined by « · » that wrap by whole parts (TASK-078 M11): «JLH-4G20TD ·
 * Автоматическая · Полный · Кроссовер», «от 12 500 ₸ · 3 предложения». Inside
 * a part the spaces are non-breaking, so a part moves to the next line whole
 * (one longer than the line still wraps inside itself — nothing is ever cut);
 * a part that starts a line loses its dot, so a line never begins or ends
 * with «·». A part is known to start a line when it lies lower than the part
 * before it; it then gets a break before it, so that, narrower without its
 * dot, it cannot jump back up and sit next to the previous one with no
 * separator at all. The measure is taken again when the width of the line
 * changes. A screen reader hears the whole line at once.
 */
export function DotLine({ parts, variant = "body", color = "text" }: DotLineProps) {
  const shown = parts
    .map((part) => (typeof part === "string" ? { text: part } : part))
    .filter((part): part is DotLinePart => !!part && part.text !== "");
  const width = useRef(0);
  const [tops, setTops] = useState<Readonly<Record<number, number>>>({});

  // The parts report their places before the line reports its width, so the
  // first width only gets remembered; a later, different width starts over.
  const onLine = (event: LayoutChangeEvent) => {
    const next = event.nativeEvent.layout.width;
    if (width.current !== 0 && width.current !== next) setTops({});
    width.current = next;
  };
  const onPart = (index: number, event: LayoutChangeEvent) => {
    const top = Math.round(event.nativeEvent.layout.y);
    setTops((current) => (current[index] === top ? current : { ...current, [index]: top }));
  };
  const startsLine = (index: number): boolean => {
    const top = tops[index];
    const before = tops[index - 1];
    return index > 0 && top !== undefined && before !== undefined && top > before + 1;
  };

  return (
    <View
      style={styles.line}
      onLayout={onLine}
      accessible
      accessibilityLabel={joinDot(shown.map((part) => part.text))}
    >
      {shown.map((part, index) => {
        const starts = startsLine(index);
        return [
          // A break before a part that starts a line: a full-width nothing.
          starts ? <View key={`break-${index}`} style={styles.break} /> : null,
          <Text
            key={index}
            variant={part.variant ?? variant}
            color={part.color ?? color}
            style={styles.part}
            onLayout={(event) => onPart(index, event)}
          >
            {(index === 0 || starts ? "" : DOT) + part.text.replace(/ /g, NBSP)}
          </Text>,
        ];
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  line: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", alignSelf: "stretch" },
  part: { flexShrink: 1, maxWidth: "100%" },
  break: { width: "100%", height: 0 },
});
