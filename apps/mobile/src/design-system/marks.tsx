import {
  compatibilityMarks,
  orderStatusGroups,
  radius,
  toneColors,
  type Compatibility,
  type IconName,
  type OrderStatusGroup,
  type Tone,
} from "@adclub/ui-core";
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Icon } from "./Icon";
import { Text } from "./text";
import { useTheme } from "./theme";

/** Role badge: `captionStrong`, radius 4, icon 16 + text (DESIGN.md 7.7). */
export function Badge({
  tone,
  icon,
  children,
}: {
  tone: Tone;
  icon: IconName;
  children: ReactNode;
}) {
  const { theme } = useTheme();
  const { foreground, background } = toneColors[tone];
  return (
    <View style={[styles.badge, { backgroundColor: theme.colors[background] }]}>
      <Icon name={icon} size={16} color={foreground} />
      <Text variant="captionStrong" color={foreground} style={styles.shrink}>
        {children}
      </Text>
    </View>
  );
}

/** Order status: group color + icon + text (DESIGN.md 7.8). */
export function StatusBadge({ group, children }: { group: OrderStatusGroup; children: ReactNode }) {
  const { tone, icon } = orderStatusGroups[group];
  return (
    <Badge tone={tone} icon={icon}>
      {children}
    </Badge>
  );
}

export function CompatibilityMark({
  value,
  children,
}: {
  value: Compatibility;
  children: ReactNode;
}) {
  const { icon, color } = compatibilityMarks[value];
  return (
    <View style={styles.inline}>
      <Icon name={icon} size={16} color={color} />
      <Text variant="captionStrong" color={color} style={styles.shrink}>
        {children}
      </Text>
    </View>
  );
}

/** "распознано" / "предложено ИИ" — sparkles + text in the AI color (DESIGN.md 7.9). */
export function AiBadge({ children }: { children: ReactNode }) {
  return (
    <View style={styles.inline}>
      <Icon name="sparkles" size={16} color="ai" />
      <Text variant="captionStrong" color="ai">
        {children}
      </Text>
    </View>
  );
}

export interface RatingProps {
  value: number | null;
  count: number;
  emptyText: string;
  label: string;
  locale: string;
}

export function Rating({ value, count, emptyText, label, locale }: RatingProps) {
  if (value === null) {
    return (
      <Text variant="bodyS" color="textMuted">
        {emptyText}
      </Text>
    );
  }
  const score = value.toLocaleString(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return (
    <View style={styles.inline} accessible accessibilityLabel={label}>
      <Icon name="star" size={16} color="accent" filled />
      <Text variant="bodyS" style={styles.tabular}>
        {score} ({count.toLocaleString(locale)})
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radius.s,
    alignSelf: "flex-start",
    maxWidth: "100%",
  },
  inline: { flexDirection: "row", alignItems: "flex-start", gap: 4, flexShrink: 1 },
  shrink: { flexShrink: 1 },
  tabular: { fontVariant: ["tabular-nums"] },
});
