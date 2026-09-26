import type { ClientCity } from "@adclub/contracts";
import { layout } from "@adclub/ui-core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Linking, ScrollView, StyleSheet, View } from "react-native";
import {
  Button,
  DataState,
  Icon,
  ListRow,
  SearchField,
  Sheet,
  SkeletonList,
  Text,
} from "../design-system";
import { detectCity } from "../services/geolocation";
import { useCities } from "../services/use-cities";
import { filterCities } from "../state/city";
import { useCity } from "../state/city-provider";
import { useT } from "../state/language";

/**
 * M-CITY-01: search, "Определить автоматически", "Весь Казахстан", the
 * cities of `/cities` in the interface language, the current one marked.
 * The same list is what the first run opens (M-START-04) — one screen for
 * one job, used from two places.
 */
export function CitySheet({
  visible,
  onClose,
  onChosen,
}: {
  visible: boolean;
  onClose: () => void;
  /** Called after a choice (the first run continues, a sheet just closes). */
  onChosen?: () => void;
}) {
  const t = useT();
  const { selection, choose, reconcile } = useCity();
  const cities = useCities();
  const [query, setQuery] = useState("");
  const [detection, setDetection] = useState<
    "idle" | "detecting" | "denied" | "unknown" | "failed"
  >("idle");

  const visibleCities = useMemo(() => filterCities(cities.cities, query), [cities.cities, query]);
  const ready = cities.status === "ready" && cities.cities.length > 0;

  // A renamed city takes its new name, an archived one falls back to "Весь
  // Казахстан" — as soon as a fresh list arrives.
  useEffect(() => {
    if (ready) reconcile(cities.cities);
  }, [ready, cities.cities, reconcile]);

  const pick = useCallback(
    (city: ClientCity | null, detected?: boolean) => {
      choose(city, detected === undefined ? undefined : { detected });
      onChosen?.();
      onClose();
    },
    [choose, onChosen, onClose],
  );

  // The system location prompt happens here and nowhere else: after a press.
  const detect = useCallback(async () => {
    setDetection("detecting");
    const outcome = await detectCity(cities.cities);
    if (outcome.kind === "city") {
      pick(outcome.city, true);
      setDetection("idle");
      return;
    }
    if (outcome.kind === "unknown") {
      // An unknown city leaves the list open with "Весь Казахстан" selected.
      choose(null, { detected: true });
    }
    setDetection(outcome.kind);
  }, [cities.cities, choose, pick]);

  const status =
    cities.status === "loading"
      ? "loading"
      : cities.status === "error"
        ? cities.offline
          ? "offline"
          : "error"
        : cities.cities.length === 0
          ? "empty"
          : "ready";

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={t("city.title")}
      closeLabel={t("common.close")}
    >
      <View style={styles.body}>
        {status === "ready" && (
          <SearchField
            label={t("city.searchLabel")}
            placeholder={t("city.searchLabel")}
            value={query}
            onChangeText={setQuery}
            clearLabel={t("common.close")}
          />
        )}

        <Button
          variant="secondary"
          size="m"
          icon="myLocation"
          loading={detection === "detecting"}
          disabled={!ready}
          onPress={detect}
        >
          {t("city.detect")}
        </Button>
        <Text variant="caption" color="textMuted">
          {t("city.detectHint")}
        </Text>
        {detection === "denied" && (
          <View style={styles.note}>
            <Text variant="bodyS" color="textMuted">
              {t("city.detectFailed")}
            </Text>
            <Button variant="text" size="m" onPress={() => Linking.openSettings()}>
              {t("city.openSettings")}
            </Button>
          </View>
        )}
        {detection === "failed" && (
          <Text variant="bodyS" color="textMuted">
            {t("city.detectFailed")}
          </Text>
        )}
        {detection === "unknown" && (
          <Text variant="bodyS" color="textMuted">
            {t("city.detectUnknown")}
          </Text>
        )}

        <DataState
          status={status}
          skeleton={<SkeletonList rows={4} label={t("common.loading")} />}
          error={{
            title: t("city.loadError"),
            text: t("state.errorText"),
            retry: { label: t("common.retry"), onRetry: cities.reload },
          }}
          offline={{
            title: t("state.offline"),
            text: t("state.offlineText"),
            action: (
              <Button variant="secondary" size="m" icon="refresh" onPress={cities.reload}>
                {t("common.retry")}
              </Button>
            ),
          }}
          empty={{ icon: "mapPin", title: t("city.listEmpty") }}
        >
          <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
            {query === "" && (
              <ListRow
                first
                title={t("city.all")}
                icon="mapPin"
                onPress={() => pick(null)}
                trailing={selection.kind === "all" ? <Icon name="check" color="accent" /> : null}
              />
            )}
            {visibleCities.map((city, index) => (
              <ListRow
                key={city.id}
                first={index === 0 && query !== ""}
                title={city.name.text}
                onPress={() => pick(city)}
                trailing={
                  selection.kind === "city" && selection.id === city.id ? (
                    <Icon name="check" color="accent" />
                  ) : null
                }
              />
            ))}
            {visibleCities.length === 0 && query !== "" && (
              <Text color="textMuted" style={styles.searchEmpty}>
                {t("city.searchEmpty")}
              </Text>
            )}
          </ScrollView>
        </DataState>

        {/* The list is per-city for services (T-CITY-01). */}
        <Text variant="caption" color="textMuted">
          {t("city.servicesNote")}
        </Text>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { gap: 8, paddingBottom: 8 },
  list: { maxHeight: 320 },
  note: { gap: 4 },
  searchEmpty: { paddingVertical: layout.cardPadding, textAlign: "center" },
});
