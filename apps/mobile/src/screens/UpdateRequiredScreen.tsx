import { translate, type Lang } from "@adclub/i18n";
import { StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button, Icon, Text, useTheme } from "../design-system";

interface UpdateRequiredScreenProps {
  lang: Lang;
  /** Text from the server's client policy. */
  message: string;
  onCheckAgain: () => Promise<unknown>;
}

export function UpdateRequiredScreen({ lang, message, onCheckAgain }: UpdateRequiredScreenProps) {
  const { theme } = useTheme();
  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.bg }]}>
      <View style={styles.content} accessibilityRole="alert">
        <Icon name="refresh" size={48} color="accent" />
        <Text variant="titleL" accessibilityRole="header" style={styles.center}>
          {translate(lang, "update.title")}
        </Text>
        <Text color="textMuted" style={styles.center}>
          {message}
        </Text>
      </View>
      {/* The button shows loading and ignores repeated presses until the check settles. */}
      <View style={styles.actions}>
        <Button onPress={onCheckAgain}>{translate(lang, "update.checkAgain")}</Button>
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
    paddingHorizontal: 24,
    gap: 12,
  },
  center: { textAlign: "center" },
  actions: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 16 },
});
