import { layout } from "@adclub/ui-core";
import { ScrollView, StyleSheet, View } from "react-native";
import { Button, Icon, ListRow, Sheet, Text } from "../../design-system";
import { carParameters, carTitle } from "../../garage/garage";
import { useGarage } from "../../state/garage-provider";
import { useT } from "../../state/language";

export interface CarSheetProps {
  visible: boolean;
  onClose: () => void;
  /** `true` while the catalog is showing everything regardless of the car. */
  filterOff: boolean;
  onFilterOff: () => void;
  onPickCar: (carId: string) => void;
  onAddCar: () => void;
}

/**
 * The car switch of the catalog header (M-CAT-01): the cars of the garage,
 * «Показать без фильтра» and a way to add one.
 *
 * «Показать без фильтра» only affects what this screen asks the server for
 * — the garage and its main car are left exactly as they were.
 */
export function CarSheet({
  visible,
  onClose,
  filterOff,
  onFilterOff,
  onPickCar,
  onAddCar,
}: CarSheetProps) {
  const t = useT();
  const { cars, state } = useGarage();

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={t("garage.parameters")}
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
                  onPickCar(car.id);
                  onClose();
                }}
                trailing={
                  !filterOff && car.id === state.primaryId ? (
                    <Icon name="check" color="accent" />
                  ) : null
                }
              />
            );
          })}
          <ListRow
            first={cars.length === 0}
            icon="category"
            title={t("catalog.showWithoutCar")}
            onPress={() => {
              onFilterOff();
              onClose();
            }}
            trailing={filterOff ? <Icon name="check" color="accent" /> : null}
          />
        </ScrollView>

        {cars.length === 0 && (
          <Text variant="bodyS" color="textMuted">
            {t("catalog.hintAddCarText")}
          </Text>
        )}
        <Button
          variant="secondary"
          icon="plus"
          onPress={() => {
            onAddCar();
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
