import { layout, radius, size } from "@adclub/ui-core";
import { useRef, useState } from "react";
import {
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
} from "react-native";
import { Icon } from "./Icon";
import { hairline } from "./lines";
import { AiBadge } from "./marks";
import { Text } from "./text";
import { useTheme } from "./theme";

/**
 * A row «parameter → value» (TASK-078 M1): the parameters of a car, the
 * characteristics of an item, the details of an order, the shares of a
 * supplier. One component, so a label and its value never read backwards:
 * the label is `body` `textMuted`, the value `bodyStrong` `text`, the row 48
 * to 56 high. A long value goes under its label (`bodyS` label, `bodyStrong`
 * value) instead of squeezing beside it.
 *
 * Rows stand in a `ListGroup`, with a hairline between them. A row that
 * opens a step gets a chevron (`navigates`); a repeated row action
 * («Дополнить» on several rows) is a plain text of the `text` colour (M16),
 * never the accent; a value the AI read is marked «распознано» and tinted
 * like an AI field (DESIGN 7.9) until a person confirms it.
 */
export interface ValueRowProps {
  label: string;
  /** The value; `null` — not set, `placeholder` is shown muted. */
  value: string | null;
  placeholder?: string;
  /** A line under the value: a note, a secondary value. */
  hint?: string;
  onPress?: () => void;
  navigates?: boolean;
  /** «Дополнить» — the text at the right edge of a row that can be completed. */
  action?: string;
  /** «распознано»: the AI badge and the AI tint of the row (DESIGN 7.9). */
  ai?: string;
  first?: boolean;
  last?: boolean;
  /** «Итого»: the label is `bodyStrong` too. */
  strong?: boolean;
  /** Where the value stands; `auto` puts a long value under its label. */
  layout?: "auto" | "inline" | "stacked";
}

/**
 * A value that would not share a line with its label. The room is counted in
 * characters of the normal font: a larger system font (`fontScale`) fits
 * proportionally fewer of them on the same line.
 */
export function valueRowStacked(label: string, value: string | null, fontScale = 1): boolean {
  if (value === null) return false;
  const scale = fontScale > 0 ? fontScale : 1;
  return value.length > 24 / scale || label.length + value.length > 34 / scale;
}

export function ValueRow({
  label,
  value,
  placeholder,
  hint,
  onPress,
  navigates,
  action,
  ai,
  first,
  last,
  strong,
  layout: layoutMode = "auto",
}: ValueRowProps) {
  const { theme } = useTheme();
  const { fontScale } = useWindowDimensions();
  // The rule of thumb counts characters; the row also looks: when the label
  // and the value beside it came out of different heights, one of them had to
  // wrap (a large font, a narrow screen) — the value goes under the label.
  // The look is kept until the row's width changes.
  const [wrapped, setWrapped] = useState(false);
  const rowWidth = useRef(0);
  const heights = useRef({ label: 0, value: 0 });
  const onRow = (event: LayoutChangeEvent) => {
    const next = event.nativeEvent.layout.width;
    if (rowWidth.current !== 0 && rowWidth.current !== next) {
      heights.current = { label: 0, value: 0 };
      setWrapped(false);
    }
    rowWidth.current = next;
  };
  const judge = () => {
    const { label: labelHeight, value: valueHeight } = heights.current;
    if (labelHeight > 0 && valueHeight > 0 && Math.abs(labelHeight - valueHeight) > 2) {
      setWrapped(true);
    }
  };
  const onLabel = (event: LayoutChangeEvent) => {
    heights.current.label = event.nativeEvent.layout.height;
    judge();
  };
  const onValue = (event: LayoutChangeEvent) => {
    heights.current.value = event.nativeEvent.layout.height;
    judge();
  };
  const stacked =
    layoutMode === "stacked" ||
    (layoutMode === "auto" && (wrapped || valueRowStacked(label, value, fontScale)));
  const shown = value ?? placeholder ?? "";
  const valueColor = value === null ? "textMuted" : "text";

  const trailing = (
    <>
      {ai !== undefined && <AiBadge>{ai}</AiBadge>}
      {action !== undefined && (
        <Text variant="bodyS" style={styles.action}>
          {action}
        </Text>
      )}
      {navigates && <Icon name="chevronRight" size={20} color="textMuted" />}
    </>
  );

  return (
    <Pressable
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={`${label}: ${shown}${action ? `, ${action}` : ""}`}
      disabled={!onPress}
      onPress={onPress}
      onLayout={onRow}
      style={({ pressed }) => [
        styles.row,
        stacked ? styles.stacked : styles.inline,
        {
          backgroundColor:
            ai !== undefined
              ? theme.colors.aiTint
              : pressed
                ? theme.colors.surfaceRaised
                : theme.colors.surface,
          borderTopColor: theme.colors.border,
          borderTopWidth: first ? 0 : hairline,
        },
        first && styles.first,
        last && styles.last,
      ]}
    >
      {stacked ? (
        <>
          <View style={styles.stackedText}>
            <Text variant="bodyS" color="textMuted">
              {label}
            </Text>
            <Text variant="bodyStrong" color={valueColor}>
              {shown}
            </Text>
            {hint !== undefined && (
              <Text variant="caption" color="textMuted">
                {hint}
              </Text>
            )}
          </View>
          <View style={styles.trailing}>{trailing}</View>
        </>
      ) : (
        <>
          <Text
            variant={strong ? "bodyStrong" : "body"}
            color="textMuted"
            style={styles.label}
            onLayout={onLabel}
          >
            {label}
          </Text>
          <View style={styles.inlineValue}>
            <Text
              variant="bodyStrong"
              color={valueColor}
              style={styles.valueText}
              onLayout={onValue}
            >
              {shown}
            </Text>
            {hint !== undefined && (
              <Text variant="caption" color="textMuted" style={styles.valueText}>
                {hint}
              </Text>
            )}
          </View>
          {trailing}
        </>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: size.touchTarget,
    paddingHorizontal: layout.rowPadding,
    paddingVertical: 12,
  },
  inline: {},
  stacked: { minHeight: 56 },
  first: { borderTopLeftRadius: radius.m, borderTopRightRadius: radius.m },
  last: { borderBottomLeftRadius: radius.m, borderBottomRightRadius: radius.m },
  label: { flexShrink: 1 },
  inlineValue: { flex: 1, alignItems: "flex-end", gap: 2 },
  // Never wider than its column: a value the font made long wraps there instead of running over the label.
  valueText: { textAlign: "right", maxWidth: "100%" },
  stackedText: { flex: 1, gap: 2 },
  trailing: { flexDirection: "row", alignItems: "center", gap: 8 },
  // The text of a repeated row action (M16): `text`, not the accent.
  action: {},
});
