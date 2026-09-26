import { layout } from "@adclub/ui-core";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Chip, DataState, OfflineBanner, Screen, SkeletonList, Text } from "../../design-system";
import { useCities } from "../../services/use-cities";
import { useOnline } from "../../services/use-network";
import { cityLabel } from "../../state/city";
import { useCity } from "../../state/city-provider";
import { useT } from "../../state/language";
import { CitySheet } from "../CitySheet";

/**
 * M-CAT-01 as a shell (TASK-028 fills it): the city switch of the header is
 * real, and the screen shows the cross-cutting states for real — the
 * skeleton while `/cities` loads, "Нет сети" without a network, the error
 * with "Повторить", and the empty state of "there is nothing here yet".
 * The car switch belongs to the garage (TASK-028).
 */
export function CatalogScreen() {
  const t = useT();
  const online = useOnline();
  const cities = useCities();
  const { selection } = useCity();
  const [sheet, setSheet] = useState(false);

  const status = !online
    ? "offline"
    : cities.status === "loading"
      ? "loading"
      : cities.status === "error"
        ? "error"
        : "empty";

  return (
    <Screen
      title={t("tabs.catalog")}
      root
      banner={!online ? <OfflineBanner label={t("state.offline")} /> : null}
      refreshing={cities.refreshing}
      refreshingLabel={t("common.loading")}
      header={
        <View style={styles.header}>
          <Chip icon="mapPin" onPress={() => setSheet(true)}>
            {cityLabel(selection, t("city.all"))}
          </Chip>
        </View>
      }
    >
      <View style={styles.content}>
        <DataState
          status={status}
          skeleton={<SkeletonList rows={4} label={t("common.loading")} />}
          error={{
            title: t("state.errorTitle"),
            text: t("state.errorText"),
            retry: { label: t("common.retry"), onRetry: cities.reload },
          }}
          offline={{ title: t("state.offline"), text: t("state.offlineText") }}
          empty={{
            icon: "category",
            title: t("catalog.emptyTitle"),
            text: t("catalog.emptyText"),
          }}
        >
          <Text>{t("catalog.emptyText")}</Text>
        </DataState>
      </View>
      <CitySheet visible={sheet} onClose={() => setSheet(false)} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", gap: 8, paddingHorizontal: layout.screenPadding, paddingTop: 4 },
  content: { paddingHorizontal: layout.screenPadding, paddingTop: 12 },
});
