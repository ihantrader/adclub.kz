import { layout } from "@adclub/ui-core";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import {
  Badge,
  Button,
  Dialog,
  ListGroup,
  ListRow,
  Screen,
  Text,
  useAfterDismiss,
  useToast,
} from "../../design-system";
import type { CarStep } from "../../garage/car-picker";
import { CAR_LEVELS, carTitle, type CarLevel, type GarageCar } from "../../garage/garage";
import { useOnline } from "../../services/use-network";
import { useGarage } from "../../state/garage-provider";
import { useT } from "../../state/language";
import { ColorSheet } from "./ColorSheet";
import { garageErrorText } from "./garage-errors";

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
 *
 * Signed in, each of them is a change of the account's garage (TASK-029.B):
 * the button waits for the server, a refusal is said and changes nothing,
 * and without a network they are off with «Нужна сеть».
 */
export function CarCardView({ car, onEdit, onDeleted, onBack }: CarCardViewProps) {
  const t = useT();
  const toast = useToast();
  const { state, remote, makePrimary, remove, update } = useGarage();
  const online = useOnline();
  const offline = remote && !online;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [colorSheet, setColorSheet] = useState(false);
  const [deleting, setDeleting] = useState(false);

  /** A change that the server may refuse: the refusal is said, the garage stays as it was. */
  const attempt = async (change: () => Promise<unknown>): Promise<boolean> => {
    try {
      await change();
      return true;
    } catch (error) {
      toast.show(garageErrorText(error, t));
      return false;
    }
  };
  // The deletion happens once the dialog has gone: it fades out first, then
  // the card leaves — not both at once.
  const dismissed = useAfterDismiss(confirmDelete);
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
        <ListGroup>
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
          {/* Colour (D-063): not a level of the vehicle catalog, so it is
              picked from its own sheet, not by opening a step — nothing
              below it in the list depends on it. */}
          <ListRow
            title={t("car.step.color")}
            subtitle={car.color === null ? t("common.notSet") : t(`car.color.${car.color}`)}
            trailing={
              car.color === null ? (
                <Text variant="bodyS" color="accent">
                  {t("garage.complete")}
                </Text>
              ) : null
            }
            onPress={() => {
              if (offline) toast.show(t("garage.needsNetwork"));
              else setColorSheet(true);
            }}
          />
        </ListGroup>

        {!primary && (
          <Button
            variant="secondary"
            disabled={offline}
            onPress={() => attempt(() => makePrimary(car.id))}
          >
            {t("garage.makePrimary")}
          </Button>
        )}

        <Button
          variant="secondary"
          destructive
          icon="trash"
          disabled={offline}
          loading={deleting}
          onPress={() => setConfirmDelete(true)}
        >
          {t("garage.delete")}
        </Button>
        {offline && (
          <Text variant="caption" color="textMuted" style={styles.center}>
            {t("garage.needsNetwork")}
          </Text>
        )}
      </View>

      <Dialog
        visible={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onDismissed={dismissed.onDismissed}
        title={t("garage.deleteTitle")}
        actions={
          <>
            <Button
              variant="danger"
              onPress={() => {
                setConfirmDelete(false);
                dismissed.after(() => {
                  setDeleting(true);
                  void attempt(() => remove(car.id)).then((removed) => {
                    setDeleting(false);
                    if (!removed) return;
                    // The screen keeps showing the car while it slides away
                    // (`GarageCarScreen`), so it never turns into «Гараж пуст».
                    onDeleted();
                    toast.show(t("garage.deleted"));
                  });
                });
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

      <ColorSheet
        visible={colorSheet}
        onClose={() => setColorSheet(false)}
        value={car.color}
        onPick={(color) => void attempt(() => update({ ...car, color }))}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: layout.screenPadding, paddingTop: 12, gap: 12 },
  center: { textAlign: "center" },
});
