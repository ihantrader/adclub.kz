import { layout, type IconName } from "@adclub/ui-core";
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Icon, Text, useTheme } from "../design-system";

/**
 * The layout of a step of the first run (M-START-04, M-START-05): the icon, the
 * question and one line of why in the middle, the actions at the bottom, clear
 * of every edge. One layout for every step, so moving from the city to the car
 * changes what is said and nothing else — the icon, the title and the buttons
 * stay where they were.
 */
export function FirstRunLayout({
  banner,
  icon,
  title,
  text,
  note,
  actions,
  children,
}: {
  /** «Нет сети», flush under the top of the screen. */
  banner?: ReactNode;
  icon: IconName;
  title: string;
  text: string;
  /** A line under the text, when something happened (the city could not be found). */
  note?: ReactNode;
  actions: ReactNode;
  /** Overlays that belong to the step (its sheet). */
  children?: ReactNode;
}) {
  const { theme } = useTheme();
  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.bg }]}>
      {banner}
      <View style={styles.content}>
        <Icon name={icon} size={48} color="accent" />
        <Text variant="titleL" accessibilityRole="header" style={styles.center}>
          {title}
        </Text>
        <Text color="textMuted" style={styles.center}>
          {text}
        </Text>
        {note}
      </View>
      <View style={styles.actions}>{actions}</View>
      {children}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: layout.screenPadding,
    gap: 12,
  },
  center: { textAlign: "center" },
  actions: { paddingHorizontal: layout.screenPadding, paddingBottom: 16, gap: 8 },
});
