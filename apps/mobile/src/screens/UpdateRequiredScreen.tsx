import { layout } from "@adclub/ui-core";
import { useState } from "react";
import { Linking, Platform, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button, ButtonLayoutProvider, Icon, Text, useTheme } from "../design-system";
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
 * Where the store opens, by the platform. Until the app is published there
 * is no listing to link to: the store's search for the app's name — one
 * constant to replace with the listing when it exists.
 */
const STORE_URL =
  Platform.OS === "ios"
    ? "https://apps.apple.com/search?term=Asia%20Drive%20Club"
    : "https://play.google.com/store/search?q=Asia%20Drive%20Club&c=apps";

/**
 * M-START-03: the server said this version is too old. The text comes from
 * the server in the interface language, with the app's own fallback
 * (T-START-02); «Откройте App Store» / «Откройте Google Play» is a text
 * button that opens the store (TASK-078) — a line that only names the store
 * was read as a button and did nothing. "Показать активные заявки" appears
 * only for a signed-in user with a saved copy of orders and opens the codes
 * read only (TASK-030).
 */
export function UpdateRequiredScreen({
  message,
  onCheckAgain,
  onShowOrders,
}: UpdateRequiredScreenProps) {
  const t = useT();
  const { theme } = useTheme();
  const [storeFailed, setStoreFailed] = useState(false);
  const openStore = () => Linking.openURL(STORE_URL).catch(() => setStoreFailed(true));
  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.bg }]}>
      {/* Scrolls when the server's text and a large system font do not fit (TASK-030.A). */}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        accessibilityRole="alert"
      >
        <Icon name="refresh" size={48} color="accent" />
        <Text variant="titleL" accessibilityRole="header" style={styles.center}>
          {t("update.title")}
        </Text>
        <Text color="textMuted" style={styles.center}>
          {message.trim() === "" ? t("update.fallbackMessage") : message}
        </Text>
        <Button variant="text" align="center" icon="externalLink" onPress={openStore}>
          {Platform.OS === "ios" ? t("update.openIos") : t("update.openAndroid")}
        </Button>
        {storeFailed && (
          <Text variant="caption" color="textMuted" style={styles.center}>
            {t("update.openStoreFailed")}
          </Text>
        )}
      </ScrollView>
      {/* The button shows loading and ignores repeated presses until the check settles. */}
      <View style={styles.actions}>
        <ButtonLayoutProvider align="stretch">
          <Button onPress={onCheckAgain}>{t("update.checkAgain")}</Button>
          {onShowOrders && (
            <Button variant="secondary" onPress={onShowOrders}>
              {t("update.showOrders")}
            </Button>
          )}
        </ButtonLayoutProvider>
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
  actions: {
    paddingHorizontal: layout.screenPadding,
    paddingTop: 12,
    paddingBottom: 16,
    gap: 12,
  },
});
