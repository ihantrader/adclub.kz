import { isApiError } from "@adclub/api-client";
import { translate, type Lang } from "@adclub/i18n";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { apiUrl, clientInfo } from "../config/environment";
import { Badge, Button, Text, useTheme } from "../design-system";
import { apiClient } from "../services/api";

type Connection = "checking" | "ok" | "failed";

/**
 * Placeholder home screen (TASK-003): proves the app talks to the API
 * through the shared client. Real screens arrive in stage B.
 */
export function HomeScreen({ lang, onOpenShowcase }: { lang: Lang; onOpenShowcase?: () => void }) {
  const { theme } = useTheme();
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

  const statusText = translate(lang, `connection.${connection}`);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.bg }]}>
      <View style={styles.content}>
        <Text variant="titleL">Asia Drive Club</Text>

        <View style={styles.status} accessibilityLiveRegion="polite">
          {connection === "checking" && (
            <>
              <ActivityIndicator color={theme.colors.accent} />
              <Text color="textMuted">{statusText}</Text>
            </>
          )}
          {connection === "ok" && (
            <Badge tone="success" icon="circleCheck">
              {statusText}
            </Badge>
          )}
          {connection === "failed" && (
            <Badge tone="danger" icon="wifiOff">
              {statusText}
            </Badge>
          )}
        </View>

        {connection === "failed" && (
          <Button variant="secondary" size="m" icon="refresh" onPress={retry}>
            {translate(lang, "common.retry")}
          </Button>
        )}

        <Text variant="caption" color="textMuted" style={styles.meta}>
          {clientInfo.platform} {clientInfo.version} · {apiUrl}
        </Text>

        {onOpenShowcase && (
          <Button variant="text" size="m" icon="category" onPress={onOpenShowcase}>
            Витрина компонентов (dev)
          </Button>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 16 },
  status: { flexDirection: "row", alignItems: "center", gap: 8 },
  meta: { textAlign: "center" },
});
