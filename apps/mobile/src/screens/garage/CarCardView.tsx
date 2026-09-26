import { layout } from "@adclub/ui-core";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Badge, Button, Dialog, ListRow, Screen, Text, useToast } from "../../design-system";
import type { CarStep } from "../../garage/car-picker";
import { CAR_LEVELS, carTitle, type CarLevel, type GarageCar } from "../../garage/garage";
import { useGarage } from "../../state/garage-provider";
import { useT } from "../../state/language";

const LEVEL_STEP_TEXT = {
  make: "car.step.make",
  model: "car.step.model",
  year: "car.step.year",
  generation: "car.step.generation",
  body: "car.step.body",
  engine: "car.step.engine",
  transmission: "car.step.transmission",
  drive: "car.step.drive",
} as const satisfies Record<CarLevel, string>;

function levelValue(car: GarageCar, level: CarLevel): string | null {
  if (level === "year") return car.year === null ? null : String(car.year);
  return car[level]?.label ?? null;
}

export interface CarCardViewProps {
  car: GarageCar;
  /** «Дополнить» and editing open M-GAR-03 at that step. */
  onEdit: (step: CarStep) => void;
  onDeleted: () => void;
  onBack: () => void;
}

/**
 * M-GAR-06 — the card of a car: every parameter, «Не указано · Дополнить»
 * for the ones that are missing, «Сделать основным» and a deletion that
 * asks first (DESIGN 7.7: the button names the action).
 */
export function CarCardView({ car, onEdit, onDeleted, onBack }: CarCardViewProps) {
  const t = useT();
  const toast = useToast();
  const { state, makePrimary, remove } = useGarage();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const primary = car.id === state.primaryId;

  return (
    <Screen title={carTitle(car)} back={{ label: t("common.back"), onPress: onBack }}>
      <View style={styles.content}>
        {primary && (
          <Badge tone="accent" icon="check">
            {t("garage.primary")}
          </Badge>
        )}

        <Text variant="heading" accessibilityRole="header">
          {t("garage.parameters")}
        </Text>
        <View style={styles.list}>
          {CAR_LEVELS.map((level, index) => {
            const value = levelValue(car, level);
            return (
              <ListRow
                key={level}
                first={index === 0}
                title={t(LEVEL_STEP_TEXT[level])}
                subtitle={value ?? t("common.notSet")}
                trailing={
                  value === null ? (
                    <Text variant="bodyS" color="accent">
                      {t("garage.complete")}
                    </Text>
                  ) : null
                }
                onPress={() => onEdit(level)}
              />
            );
          })}
        </View>

        {!primary && (
          <Button variant="secondary" onPress={() => makePrimary(car.id)}>
            {t("garage.makePrimary")}
          </Button>
        )}

        <Button variant="secondary" destructive icon="trash" onPress={() => setConfirmDelete(true)}>
          {t("garage.delete")}
        </Button>
      </View>

      <Dialog
        visible={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={t("garage.deleteTitle")}
        actions={
          <>
            <Button
              variant="danger"
              onPress={() => {
                setConfirmDelete(false);
                remove(car.id);
                toast.show(t("garage.deleted"));
                onDeleted();
              }}
            >
              {t("garage.delete")}
            </Button>
            <Button variant="secondary" onPress={() => setConfirmDelete(false)}>
              {t("common.cancel")}
            </Button>
          </>
        }
      >
        {t("garage.deleteText", { car: carTitle(car) })}
      </Dialog>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: layout.screenPadding, paddingTop: 12, gap: 12 },
  list: { gap: 0 },
});
