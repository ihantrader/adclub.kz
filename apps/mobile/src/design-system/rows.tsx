import { layout, radius, size } from "@adclub/ui-core";
import { Pressable, StyleSheet, View } from "react-native";
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

/** A value that would not share a line with its label. */
export function valueRowStacked(label: string, value: string | null): boolean {
  if (value === null) return false;
  return value.length > 24 || label.length + value.length > 34;
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
  const stacked =
    layoutMode === "stacked" || (layoutMode === "auto" && valueRowStacked(label, value));
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
          <Text variant={strong ? "bodyStrong" : "body"} color="textMuted" style={styles.label}>
            {label}
          </Text>
          <View style={styles.inlineValue}>
            <Text variant="bodyStrong" color={valueColor} style={styles.valueText}>
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
  valueText: { textAlign: "right" },
  stackedText: { flex: 1, gap: 2 },
  trailing: { flexDirection: "row", alignItems: "center", gap: 8 },
  // The text of a repeated row action (M16): `text`, not the accent.
  action: {},
});
