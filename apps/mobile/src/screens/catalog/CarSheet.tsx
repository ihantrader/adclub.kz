import { space } from "@adclub/ui-core";
import { ScrollView, StyleSheet, View } from "react-native";
import { Button, Icon, ListRow, Sheet, Text, useAfterDismiss } from "../../design-system";
import { carParameters, carTitle } from "../../garage/garage";
import { useOnline } from "../../services/use-network";
import { useGarage } from "../../state/garage-provider";
import { useT } from "../../state/language";

export interface CarSheetProps {
  visible: boolean;
  onClose: () => void;
  onPickCar: (carId: string) => Promise<void> | void;
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
 *
 * Signed in, another car is a change of the account (TASK-029.B): without a
 * network only the current one is shown as chosen, the others wait with
 * «Нужна сеть».
 */
export function CarSheet({ visible, onClose, onPickCar, onAddCar }: CarSheetProps) {
  const t = useT();
  const { cars, state, remote } = useGarage();
  const online = useOnline();
  const offline = remote && !online;
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
            const current = car.id === state.primaryId;
            return (
              <ListRow
                key={car.id}
                first={index === 0}
                icon="car"
                title={carTitle(car)}
                subtitle={parameters.length > 0 ? parameters.join(" · ") : undefined}
                onPress={
                  offline && !current
                    ? undefined
                    : () => {
                        dismissed.after(() => void onPickCar(car.id));
                        onClose();
                      }
                }
                trailing={current ? <Icon name="check" color="accent" /> : null}
              />
            );
          })}
        </ScrollView>
        {offline && cars.length > 1 && (
          <Text variant="caption" color="textMuted">
            {t("garage.needsNetwork")}
          </Text>
        )}

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
  body: { gap: 12, paddingBottom: space[3] },
  list: { maxHeight: 320 },
});
