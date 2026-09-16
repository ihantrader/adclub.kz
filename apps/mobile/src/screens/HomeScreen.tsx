import { isApiError } from "@adclub/api-client";
import { translate, type Lang } from "@adclub/i18n";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { apiUrl, clientInfo } from "../config/environment";
import { apiClient } from "../services/api";
import { colors } from "../theme";

type Connection = "checking" | "ok" | "failed";

/**
 * Placeholder home screen (TASK-003): proves the app talks to the API
 * through the shared client. Real screens arrive in stage B.
 */
export function HomeScreen({ lang }: { lang: Lang }) {
  const [connection, setConnection] = useState<Connection>("checking");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .getHealth()
      .then(() => {
        if (!cancelled) setConnection("ok");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // Any HTTP answer means the server is reachable.
        setConnection(isApiError(error) && error.code !== "NETWORK_ERROR" ? "ok" : "failed");
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const retry = useCallback(() => {
    setConnection("checking");
    setAttempt((value) => value + 1);
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>adclub.kz</Text>

      <View style={styles.status}>
        {connection === "checking" && <ActivityIndicator color={colors.primary} />}
        <Text style={[styles.statusText, connection === "failed" && styles.failed]}>
          {translate(lang, `connection.${connection}`)}
        </Text>
      </View>

      {connection === "failed" && (
        <Pressable accessibilityRole="button" onPress={retry} style={styles.button}>
          <Text style={styles.buttonText}>{translate(lang, "common.retry")}</Text>
        </Pressable>
      )}

      <Text style={styles.meta}>
        {clientInfo.platform} {clientInfo.version} · {apiUrl}
      </Text>
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
  title: { fontSize: 28, fontWeight: "700", marginBottom: 16, color: colors.text },
  status: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 16 },
  statusText: { fontSize: 16, color: colors.primary },
  failed: { color: colors.danger },
  button: {
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 8,
    backgroundColor: colors.primary,
    marginBottom: 16,
  },
  buttonText: { color: colors.primaryText, fontSize: 16 },
  meta: { fontSize: 12, color: colors.mutedText },
});
