import { useCallback, useState } from "react";
import { Button, OfflineBanner, Text } from "../design-system";
import { detectCity } from "../services/geolocation";
import { useOnline } from "../services/use-network";
import { useCities } from "../services/use-cities";
import { useCity } from "../state/city-provider";
import { useT } from "../state/language";
import { CitySheet } from "./CitySheet";
import { FirstRunLayout } from "./FirstRunLayout";

const centered = { textAlign: "center" } as const;

/**
 * M-START-04, the first run: "Где вы находитесь?", "Определить
 * автоматически" (the system prompt only after the press) and "Выбрать из
 * списка". Whatever happens next — a detected city, a refusal, an unknown
 * city, a list that would not load — the run can be finished: the app never
 * gets stuck on this screen.
 */
export function FirstRunCityScreen({ onDone }: { onDone: () => void }) {
  const t = useT();
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
    <FirstRunLayout
      banner={!online ? <OfflineBanner label={t("state.offline")} /> : null}
      icon="mapPin"
      title={t("city.firstRunTitle")}
      text={t("city.firstRunText")}
      note={
        note !== null ? (
          <Text variant="bodyS" color="textMuted" style={centered}>
            {t(note === "unknown" ? "city.detectUnknown" : "city.detectFailed")}
          </Text>
        ) : null
      }
      actions={
        <>
          <Button icon="myLocation" disabled={cities.status !== "ready"} onPress={detect}>
            {t("city.detect")}
          </Button>
          <Text variant="caption" color="textMuted" style={centered}>
            {t("city.detectHint")}
          </Text>
          <Button variant="secondary" onPress={() => setSheet(true)}>
            {t("city.chooseFromList")}
          </Button>
          {cities.status === "error" && (
            // The list could not be loaded: retry, or go on with "Весь Казахстан".
            <>
              <Text variant="bodyS" color="textMuted" style={centered}>
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
        </>
      }
    >
      <CitySheet visible={sheet} onClose={() => setSheet(false)} onChosen={onDone} />
    </FirstRunLayout>
  );
}
