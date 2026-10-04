import { layout } from "@adclub/ui-core";
import { Platform, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button, Icon, IconBadge, Text, useTheme } from "../design-system";
import { useT } from "../state/language";

interface UpdateRequiredScreenProps {
  /** Text of the server's client policy; empty — the app's own fallback text. */
  message: string;
  onCheckAgain: () => Promise<unknown>;
  /**
   * «Показать активные заявки» (TASK-030, D-027): given only when the person
   * is signed in and the device holds a copy with orders — otherwise there
   * is no such button.
   */
  onShowOrders?: () => void;
}

/**
 * M-START-03: the server said this version is too old. The text comes from
 * the server in the interface language, with the app's own fallback
 * (T-START-02); the store line follows the platform. "Показать активные
 * заявки" appears only for a signed-in user with a saved copy of orders and
 * opens the codes read only (TASK-030).
 */
export function UpdateRequiredScreen({
  message,
  onCheckAgain,
  onShowOrders,
}: UpdateRequiredScreenProps) {
  const t = useT();
  const { theme } = useTheme();
  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.bg }]}>
      {/* Scrolls when the server's text and a large system font do not fit (TASK-030.A). */}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        accessibilityRole="alert"
      >
        <IconBadge size={48}>
          <Icon name="refresh" size={48} color="accent" />
        </IconBadge>
        <Text variant="titleL" accessibilityRole="header" style={styles.center}>
          {t("update.title")}
        </Text>
        <Text color="textMuted" style={styles.center}>
          {message.trim() === "" ? t("update.fallbackMessage") : message}
        </Text>
        <Text variant="bodyStrong" style={styles.center}>
          {Platform.OS === "ios" ? t("update.openIos") : t("update.openAndroid")}
        </Text>
      </ScrollView>
      {/* The button shows loading and ignores repeated presses until the check settles. */}
      <View style={styles.actions}>
        <Button onPress={onCheckAgain}>{t("update.checkAgain")}</Button>
        {onShowOrders && (
          <Button variant="secondary" onPress={onShowOrders}>
            {t("update.showOrders")}
          </Button>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { flex: 1 },
  content: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: layout.blockGap,
    gap: 12,
  },
  center: { textAlign: "center" },
  actions: { paddingHorizontal: layout.screenPadding, paddingTop: 12, paddingBottom: 16, gap: 8 },
});
