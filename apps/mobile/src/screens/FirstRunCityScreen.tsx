import { layout } from "@adclub/ui-core";
import { useCallback, useState } from "react";
import { StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button, Icon, OfflineBanner, Text, useTheme } from "../design-system";
import { detectCity } from "../services/geolocation";
import { useOnline } from "../services/use-network";
import { useCities } from "../services/use-cities";
import { useCity } from "../state/city-provider";
import { useT } from "../state/language";
import { CitySheet } from "./CitySheet";

/**
 * M-START-04, the first run: "Где вы находитесь?", "Определить
 * автоматически" (the system prompt only after the press) and "Выбрать из
 * списка". Whatever happens next — a detected city, a refusal, an unknown
 * city, a list that would not load — the run can be finished: the app never
 * gets stuck on this screen.
 */
export function FirstRunCityScreen({ onDone }: { onDone: () => void }) {
  const t = useT();
  const { theme } = useTheme();
  const online = useOnline();
  const cities = useCities();
  const { choose } = useCity();
  const [sheet, setSheet] = useState(false);
  const [note, setNote] = useState<"denied" | "unknown" | "failed" | null>(null);

  const detect = useCallback(async () => {
    const outcome = await detectCity(cities.cities);
    if (outcome.kind === "city") {
      choose(outcome.city, { detected: true });
      onDone();
      return;
    }
    // A refusal, a place we do not know and a failure all lead to the list
    // with "Весь Казахстан" selected (SCREENS 5.1).
    choose(null, { detected: true });
    setNote(outcome.kind);
    setSheet(true);
  }, [cities.cities, choose, onDone]);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.bg }]}>
      {!online && <OfflineBanner label={t("state.offline")} />}
      <View style={styles.content}>
        <Icon name="mapPin" size={48} color="accent" />
        <Text variant="titleL" accessibilityRole="header" style={styles.center}>
          {t("city.firstRunTitle")}
        </Text>
        <Text color="textMuted" style={styles.center}>
          {t("city.firstRunText")}
        </Text>
        {note !== null && (
          <Text variant="bodyS" color="textMuted" style={styles.center}>
            {t(note === "unknown" ? "city.detectUnknown" : "city.detectFailed")}
          </Text>
        )}
      </View>
      <View style={styles.actions}>
        <Button icon="myLocation" disabled={cities.status !== "ready"} onPress={detect}>
          {t("city.detect")}
        </Button>
        <Text variant="caption" color="textMuted" style={styles.center}>
          {t("city.detectHint")}
        </Text>
        <Button variant="secondary" onPress={() => setSheet(true)}>
          {t("city.chooseFromList")}
        </Button>
        {cities.status === "error" && (
          // The list could not be loaded: retry, or go on with "Весь Казахстан".
          <>
            <Text variant="bodyS" color="textMuted" style={styles.center}>
              {online ? t("city.loadError") : t("state.offlineText")}
            </Text>
            <Button variant="text" icon="refresh" onPress={cities.reload}>
              {t("common.retry")}
            </Button>
            <Button
              variant="text"
              onPress={() => {
                choose(null);
                onDone();
              }}
            >
              {t("city.continueWithAll")}
            </Button>
          </>
        )}
      </View>
      <CitySheet visible={sheet} onClose={() => setSheet(false)} onChosen={onDone} />
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
