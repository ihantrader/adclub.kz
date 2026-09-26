import { Button } from "../design-system";
import { useVehicleMakes } from "../services/use-vehicles";
import { useT } from "../state/language";
import { FirstRunLayout } from "./FirstRunLayout";

/**
 * M-START-05 — the car of the first run. Only the list is available (photo
 * and voice are stage D), so the screen offers it and nothing else: there is
 * no «Пропустить» (D-062) — the app is for car owners, the catalog does not
 * exist without a car, and the first run is over when a car has been added.
 * The choice itself is the same steps M-GAR-03 the garage uses, opened by
 * `onChooseFromList` as the first of them.
 */
export function FirstRunCarScreen({ onChooseFromList }: { onChooseFromList: () => void }) {
  const t = useT();
  // The first step asks for the makes. Asking now, while the person reads the
  // question, means the list is there when the step slides in.
  useVehicleMakes();

  return (
    <FirstRunLayout
      icon="car"
      title={t("start.carTitle")}
      text={t("start.carText")}
      actions={
        <Button icon="car" onPress={onChooseFromList}>
          {t("city.chooseFromList")}
        </Button>
      }
    />
  );
}
