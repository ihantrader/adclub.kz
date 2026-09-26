import { layout } from "@adclub/ui-core";
import { StyleSheet, View } from "react-native";
import { EmptyState, OfflineBanner, Screen } from "../../design-system";
import { useOnline } from "../../services/use-network";
import { useT } from "../../state/language";

/**
 * M-GAR-01 as a shell (TASK-028 fills it). The garage of a guest is kept on
 * the device, so it works without a network (SCREENS 2.4) — the banner says
 * there is none, the screen still shows the garage. Its "Добавить
 * автомобиль" action arrives with TASK-028.
 */
export function GarageScreen() {
  const t = useT();
  const online = useOnline();

  return (
    <Screen
      title={t("tabs.garage")}
      root
      banner={!online ? <OfflineBanner label={t("state.offline")} /> : null}
    >
      <View style={styles.content}>
        <EmptyState icon="car" title={t("garage.emptyTitle")} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: layout.screenPadding, paddingTop: 12 },
});
