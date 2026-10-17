import {
  aiPilotButtonColorway,
  fontScale,
  layout,
  radius,
  size,
  type IconName,
} from "@adclub/ui-core";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AiPilot } from "./AiPilot";
import { useToastObstacle } from "./feedback";
import { hairline } from "./lines";
import { IconButton } from "./Button";
import { Icon } from "./Icon";
import { Text } from "./text";
import { useTheme } from "./theme";

export interface TabItem<K extends string> {
  key: K;
  label: string;
  icon: IconName;
}

export interface BottomTabsProps<K extends string> {
  items: readonly TabItem<K>[];
  active: K;
  onSelect: (key: K) => void;
  /**
   * The raised AI Pilot button in the middle (stage D). Without it the bar
   * has four tabs (stages B–C, SCREENS 3.1).
   */
  aiPilot?: { key: K; label: string; accessibilityLabel: string };
}

/**
 * Tab bar: 64 + safe area, `bar` background, `border` line on top, icons 24,
 * labels `tab` (at most 120 % with the system font size). Center — AI Pilot:
 * circle 60 `primary`, raised by 20, 4 px ring of `bar`, character 40 idle,
 * label always `accent` (DESIGN.md 7.7).
 */
export function BottomTabs<K extends string>({
  items,
  active,
  onSelect,
  aiPilot,
}: BottomTabsProps<K>) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  // A toast stands above the bar and the raised AI Pilot button (7.7, TASK-032).
  const { ref: barRef, onLayout: onBarLayout } = useToastObstacle();
  const { ref: pilotRef, onLayout: onPilotLayout } = useToastObstacle();
  const half = Math.ceil(items.length / 2);
  const { diameter, lift, ring, figure } = size.centerTab;

  const tab = (item: TabItem<K>) => {
    const on = item.key === active;
    return (
      <Pressable
        key={item.key}
        accessibilityRole="tab"
        accessibilityState={{ selected: on }}
        accessibilityLabel={item.label}
        onPress={() => onSelect(item.key)}
        style={styles.tab}
      >
        <Icon name={item.icon} size={24} color={on ? "accent" : "textMuted"} />
        <Text
          variant="tab"
          color={on ? "accent" : "textMuted"}
          numberOfLines={1}
          maxFontSizeMultiplier={fontScale.tabLabelMax}
        >
          {item.label}
        </Text>
      </Pressable>
    );
  };

  return (
    <View
      ref={barRef}
      onLayout={onBarLayout}
      accessibilityRole="tablist"
      style={[
        styles.bar,
        {
          backgroundColor: theme.colors.bar,
          borderTopColor: theme.colors.border,
          paddingBottom: insets.bottom,
        },
      ]}
    >
      {items.slice(0, half).map(tab)}
      {aiPilot && (
        <Pressable
          accessibilityRole="tab"
          accessibilityLabel={aiPilot.accessibilityLabel}
          accessibilityState={{ selected: aiPilot.key === active }}
          onPress={() => onSelect(aiPilot.key)}
          style={styles.tab}
        >
          <View
            ref={pilotRef}
            onLayout={onPilotLayout}
            style={[
              styles.pilotButton,
              {
                width: diameter,
                height: diameter,
                marginTop: -(lift + 8),
                borderWidth: ring,
                borderColor: theme.colors.bar,
                backgroundColor: theme.colors.primary,
              },
            ]}
          >
            <AiPilot
              state="idle"
              colorway={aiPilotButtonColorway(theme.name)}
              size={figure}
              accessibilityLabel={null}
            />
          </View>
          <Text
            variant="tab"
            color="accent"
            numberOfLines={1}
            maxFontSizeMultiplier={fontScale.tabLabelMax}
          >
            {aiPilot.label}
          </Text>
        </Pressable>
      )}
      {items.slice(half).map(tab)}
    </View>
  );
}

export interface TopBarProps {
  title: string;
  /** Root screens use `titleL`. */
  root?: boolean;
  back?: { label: string; onPress: () => void };
  actions?: ReactNode;
  /** While the content is scrolled: `bar` background and a bottom line. */
  scrolled?: boolean;
  /**
   * The title is drawn only while `scrolled` (TASK-078 M12): a screen whose
   * content opens with the same name as its heading (the card of an item)
   * shows it in the bar once the heading has gone under it.
   */
  titleAfterScroll?: boolean;
  /** The line under the bar belongs to a pinned header below it instead. */
  lineBelow?: boolean;
}

/** Top bar: 56 high, title on the left (DESIGN.md 7.7). */
export function TopBar({
  title,
  root,
  back,
  actions,
  scrolled,
  titleAfterScroll,
  lineBelow = true,
}: TopBarProps) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const titleShown = !titleAfterScroll || scrolled;
  return (
    <View
      style={[
        styles.topBar,
        {
          paddingTop: insets.top,
          backgroundColor: scrolled ? theme.colors.bar : theme.colors.bg,
          borderBottomColor: scrolled && lineBelow ? theme.colors.border : "transparent",
        },
      ]}
    >
      <View style={styles.topBarRow}>
        {back && <IconButton icon="arrowLeft" label={back.label} onPress={back.onPress} />}
        <Text
          variant={root ? "titleL" : "title"}
          accessibilityRole="header"
          accessibilityElementsHidden={!titleShown}
          importantForAccessibility={titleShown ? "auto" : "no-hide-descendants"}
          numberOfLines={titleAfterScroll ? 1 : 2}
          style={[
            styles.topBarTitle,
            !back && styles.topBarTitleInset,
            !titleShown && styles.unseen,
          ]}
        >
          {title}
        </Text>
        {actions}
      </View>
    </View>
  );
}

export interface ListRowProps {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: IconName;
  /** Keeps the column of the icon empty, so rows with and without one align (TASK-078 M-CITY-01). */
  iconSlot?: boolean;
  /** Something other than a semantic icon at the left: the icon of a category, a colour swatch. */
  leading?: ReactNode;
  trailing?: ReactNode;
  onPress?: () => void;
  /** Adds a chevron for rows that open a screen. */
  navigates?: boolean;
  first?: boolean;
  /** The last row of a list that stands on the page itself (a FlatList): rounded below. */
  last?: boolean;
  /** A row of a card group on the page itself: rounded above when first. */
  rounded?: boolean;
}

/**
 * List row: min 56, fields 16 / 16, `surface`, hairline `border` between rows;
 * pressed — `surfaceRaised` (DESIGN.md 7.7, D-068).
 */
export function ListRow({
  title,
  subtitle,
  icon,
  iconSlot,
  leading,
  trailing,
  onPress,
  navigates,
  first,
  last,
  rounded,
}: ListRowProps) {
  const { theme } = useTheme();
  return (
    <Pressable
      accessibilityRole={onPress ? "button" : undefined}
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        // The caret glyph carries air of its own: 12 reads as the 16 of the text.
        navigates && styles.rowWithChevron,
        rounded && first && styles.rowFirst,
        last && styles.rowLast,
        {
          backgroundColor: pressed ? theme.colors.surfaceRaised : theme.colors.surface,
          borderTopColor: theme.colors.border,
          borderTopWidth: first ? 0 : hairline,
        },
      ]}
    >
      {leading ??
        (icon ? (
          <Icon name={icon} size={24} color="textMuted" />
        ) : (
          iconSlot && <View style={styles.iconSlot} />
        ))}
      <View style={styles.rowText}>
        {typeof title === "string" ? <Text variant="bodyStrong">{title}</Text> : title}
        {typeof subtitle === "string" ? (
          <Text variant="bodyS" color="textMuted">
            {subtitle}
          </Text>
        ) : (
          subtitle
        )}
      </View>
      {trailing}
      {navigates && <Icon name="chevronRight" size={20} color="textMuted" />}
    </Pressable>
  );
}

/**
 * Rows of one kind together (TASK-030.A): a `radiusM` block of `surface` rows
 * with hairlines between them and no frame — the rows differ from the page by
 * their color (DESIGN.md 7.6, D-068) — the profile's settings, the parameters of
 * a car, the characteristics of an item, the course of an order. One look
 * for every list of rows inside a screen's padding.
 */
export function ListGroup({ children }: { children: ReactNode }) {
  const { theme } = useTheme();
  return <View style={[styles.group, { backgroundColor: theme.colors.surface }]}>{children}</View>;
}

const styles = StyleSheet.create({
  group: { borderRadius: radius.m, overflow: "hidden" },
  bar: {
    flexDirection: "row",
    alignItems: "flex-end",
    borderTopWidth: hairline,
    paddingTop: 8,
    paddingHorizontal: 4,
    minHeight: size.tabBar,
  },
  tab: {
    flex: 1,
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 2,
    minHeight: size.touchTarget,
    paddingBottom: 6,
  },
  pilotButton: { borderRadius: radius.full, alignItems: "center", justifyContent: "center" },
  topBar: { borderBottomWidth: hairline },
  topBarRow: {
    minHeight: size.topBar,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 4,
    gap: 4,
  },
  topBarTitle: { flex: 1 },
  topBarTitleInset: { paddingLeft: 12 },
  unseen: { opacity: 0 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 56,
    paddingHorizontal: layout.rowPadding,
    paddingVertical: layout.rowPadding,
  },
  rowWithChevron: { paddingRight: 12 },
  rowFirst: { borderTopLeftRadius: radius.m, borderTopRightRadius: radius.m },
  rowLast: { borderBottomLeftRadius: radius.m, borderBottomRightRadius: radius.m },
  iconSlot: { width: 24 },
  rowText: { flex: 1, gap: 2 },
});
