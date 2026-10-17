import {
  compatibilityMarks,
  orderStatusGroups,
  radius,
  toneColors,
  type ColorToken,
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

/**
 * A small fact with its icon and no plate (TASK-078 M6): «В наличии»,
 * «Самовывоз: завтра», «Есть в Алматы». Green and the plates are for
 * compatibility and the state of an order (DESIGN 7.8); a fact is a line.
 */
export function IconLine({
  icon,
  color = "textMuted",
  variant = "caption",
  textColor,
  children,
}: {
  icon: IconName;
  color?: ColorToken;
  variant?: "caption" | "bodyS" | "body";
  /** The text's colour when it differs from the icon's (`text` next to a muted icon). */
  textColor?: ColorToken;
  children: ReactNode;
}) {
  return (
    <View style={styles.inlineCentered}>
      <Icon name={icon} size={16} color={color} />
      <Text variant={variant} color={textColor ?? color} style={styles.shrink}>
        {children}
      </Text>
    </View>
  );
}

/** "распознано" / "предложено ИИ" — sparkles + text in the AI color (DESIGN.md 7.9). */
export function AiBadge({ children }: { children: ReactNode }) {
  // Beside a field's value the badge gives way: at a large system font it
  // ends in an ellipsis instead of running past the frame of the field.
  return (
    <View style={[styles.inline, styles.shrink]}>
      <Icon name="sparkles" size={16} color="ai" />
      <Text variant="captionStrong" color="ai" numberOfLines={1} style={styles.shrink}>
        {children}
      </Text>
    </View>
  );
}

/**
 * An icon on a round `accentTint` plate (DESIGN 7.6: «на плитках категорий —
 * крупнее, на круглой подложке акцента»): the catalog's category tiles and
 * the cards of the garage. The plate is the icon's own size plus a ring of
 * the same width on each side of it, so a 28 icon sits on a 56 circle.
 */
export function IconBadge({
  children,
  size,
  tone = "fill",
}: {
  children: ReactNode;
  size: number;
  /** `fill` — a neutral plate (the person of the profile); `accent` — the one accent plate of a screen. */
  tone?: "accent" | "fill";
}) {
  const { theme } = useTheme();
  return (
    <View
      style={[
        styles.iconBadge,
        {
          width: size * 2,
          height: size * 2,
          borderRadius: size,
          backgroundColor: tone === "accent" ? theme.colors.accentTint : theme.colors.fill,
        },
      ]}
    >
      {children}
    </View>
  );
}

export interface RatingProps {
  value: number | null;
  count: number;
  emptyText: string;
  label: string;
  locale: string;
  /**
   * The rating of a supplier's page (M-CAT-09, TASK-078): a 24 star, the
   * value `title` and the number of ratings in words (`countText`).
   */
  large?: boolean;
  countText?: string;
}

export function Rating({ value, count, emptyText, label, locale, large, countText }: RatingProps) {
  if (value === null) {
    return (
      <Text variant={large ? "body" : "bodyS"} color="textMuted">
        {emptyText}
      </Text>
    );
  }
  const score = value.toLocaleString(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  if (large) {
    return (
      <View style={styles.ratingLarge} accessible accessibilityLabel={label}>
        <Icon name="star" size={24} color="accent" filled />
        <Text variant="title" style={styles.tabular}>
          {score}
        </Text>
        <Text variant="bodyS" color="textMuted">
          {countText ?? count.toLocaleString(locale)}
        </Text>
      </View>
    );
  }
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
  inlineCentered: { flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1 },
  ratingLarge: { flexDirection: "row", alignItems: "center", gap: 8 },
  iconBadge: { alignItems: "center", justifyContent: "center" },
  shrink: { flexShrink: 1 },
  tabular: { fontVariant: ["tabular-nums"] },
});
