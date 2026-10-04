import { layout } from "@adclub/ui-core";
import { ScrollView, StyleSheet, View } from "react-native";
import { Button, Icon, ListRow, Sheet, useAfterDismiss } from "../../design-system";
import { carParameters, carTitle } from "../../garage/garage";
import { useGarage } from "../../state/garage-provider";
import { useT } from "../../state/language";

export interface CarSheetProps {
  visible: boolean;
  onClose: () => void;
  onPickCar: (carId: string) => void;
  onAddCar: () => void;
}

/**
 * The car switch of the catalog header (M-CAT-01): the cars of the garage
 * and a way to add one. The catalog is always for one of them (D-062), so
 * there is no row for looking without a car.
 *
 * What a tap starts — the catalog reloading for another car, the steps of
 * choosing one opening — waits until the sheet has gone: the sheet closes,
 * and then the screen moves, not both at once.
 */
export function CarSheet({ visible, onClose, onPickCar, onAddCar }: CarSheetProps) {
  const t = useT();
  const { cars, state } = useGarage();
  const dismissed = useAfterDismiss(visible);

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      onDismissed={dismissed.onDismissed}
      title={t("catalog.carSheetTitle")}
      closeLabel={t("common.close")}
    >
      <View style={styles.body}>
        <ScrollView style={styles.list}>
          {cars.map((car, index) => {
            const parameters = carParameters(car);
            return (
              <ListRow
                key={car.id}
                first={index === 0}
                icon="car"
                title={carTitle(car)}
                subtitle={parameters.length > 0 ? parameters.join(" · ") : undefined}
                onPress={() => {
                  dismissed.after(() => onPickCar(car.id));
                  onClose();
                }}
                trailing={car.id === state.primaryId ? <Icon name="check" color="accent" /> : null}
              />
            );
          })}
        </ScrollView>

        <Button
          variant="secondary"
          icon="plus"
          onPress={() => {
            dismissed.after(onAddCar);
            onClose();
          }}
        >
          {t("garage.add")}
        </Button>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { gap: 12, paddingBottom: layout.cardPaddingS },
  list: { maxHeight: 320 },
});
