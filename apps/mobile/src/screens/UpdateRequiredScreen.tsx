import { layout } from "@adclub/ui-core";
import { Platform, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button, Icon, Text, useTheme } from "../design-system";
import { useT } from "../state/language";

interface UpdateRequiredScreenProps {
  /** Text of the server's client policy; empty — the app's own fallback text. */
  message: string;
  onCheckAgain: () => Promise<unknown>;
}

/**
 * M-START-03: the server said this version is too old. The text comes from
 * the server in the interface language, with the app's own fallback
 * (T-START-02); the store line follows the platform. "Показать активные
 * заявки" appears only for a signed-in user with a saved copy of orders
 * (TASK-029/030) — there is neither yet, so the button is not built.
 */
export function UpdateRequiredScreen({ message, onCheckAgain }: UpdateRequiredScreenProps) {
  const t = useT();
  const { theme } = useTheme();
  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.bg }]}>
      <View style={styles.content} accessibilityRole="alert">
        <Icon name="refresh" size={48} color="accent" />
        <Text variant="titleL" accessibilityRole="header" style={styles.center}>
          {t("update.title")}
        </Text>
        <Text color="textMuted" style={styles.center}>
          {message.trim() === "" ? t("update.fallbackMessage") : message}
        </Text>
        <Text variant="bodyStrong" style={styles.center}>
          {Platform.OS === "ios" ? t("update.openIos") : t("update.openAndroid")}
        </Text>
      </View>
      {/* The button shows loading and ignores repeated presses until the check settles. */}
      <View style={styles.actions}>
        <Button onPress={onCheckAgain}>{t("update.checkAgain")}</Button>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: layout.blockGap,
    gap: 12,
  },
  center: { textAlign: "center" },
  actions: { paddingHorizontal: layout.screenPadding, paddingTop: 12, paddingBottom: 16 },
});
