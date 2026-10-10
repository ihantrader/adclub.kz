import { StyleSheet } from "react-native";
import { Text } from "../design-system";
import { CarAddingActions } from "../navigation/car-adding";
import { useVehicleMakes } from "../services/use-vehicles";
import { useT } from "../state/language";
import { FirstRunLayout } from "./FirstRunLayout";

/**
 * M-START-05 — the car of the first run. There is no «Пропустить» (D-062):
 * the app is for car owners, the catalog does not exist without a car, and
 * the first run is over when a car has been added.
 *
 * Since TASK-057 (D-064) the car is added by a photo of its registration
 * certificate — the camera first, the gallery next to it; the list appears
 * only after recognition did not work (`CarAddingActions`). Whatever the
 * way, the steps M-GAR-03 and the final step are the garage's own.
 */
export function FirstRunCarScreen() {
  const t = useT();
  // The steps ask for the makes. Asking now, while the person reads the
  // question, means the list is there when the step slides in.
  useVehicleMakes();

  return (
    <FirstRunLayout
      icon="car"
      title={t("start.carTitle")}
      text={t("start.carText")}
      note={
        <Text variant="bodyS" color="textMuted" style={styles.center}>
          {t("doc.privacy")}
        </Text>
      }
      actions={<CarAddingActions origin="first-run" />}
    />
  );
}

const styles = StyleSheet.create({
  center: { textAlign: "center" },
});
