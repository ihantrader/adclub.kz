import { translate, type Lang } from "@adclub/i18n";
import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../theme";

interface UpdateRequiredScreenProps {
  lang: Lang;
  /** Text from the server's client policy. */
  message: string;
  onCheckAgain: () => Promise<unknown>;
}

export function UpdateRequiredScreen({ lang, message, onCheckAgain }: UpdateRequiredScreenProps) {
  const [checking, setChecking] = useState(false);

  const checkAgain = () => {
    setChecking(true);
    void onCheckAgain().finally(() => setChecking(false));
  };

  return (
    <View style={styles.container} accessibilityRole="alert">
      <Text style={styles.title}>{translate(lang, "update.title")}</Text>
      <Text style={styles.message}>{message}</Text>
      <Pressable
        accessibilityRole="button"
        disabled={checking}
        onPress={checkAgain}
        style={({ pressed }) => [styles.button, (pressed || checking) && styles.buttonPressed]}
      >
        {checking ? (
          <ActivityIndicator color={colors.primaryText} />
        ) : (
          <Text style={styles.buttonText}>{translate(lang, "update.checkAgain")}</Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    backgroundColor: colors.background,
  },
  title: { fontSize: 22, fontWeight: "600", marginBottom: 12, color: colors.text },
  message: { fontSize: 16, textAlign: "center", marginBottom: 24, color: colors.text },
  button: {
    minWidth: 180,
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 8,
    backgroundColor: colors.primary,
  },
  buttonPressed: { opacity: 0.7 },
  buttonText: { color: colors.primaryText, fontSize: 16 },
});
