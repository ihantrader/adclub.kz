import { layout } from "@adclub/ui-core";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import {
  Button,
  Dialog,
  ListGroup,
  ListRow,
  Screen,
  Text,
  useAfterDismiss,
  useToast,
} from "../../design-system";
import type { CarColorId } from "../../garage/car-color";
import {
  draftToCar,
  levelsClearedBy,
  summaryRows,
  type CarDraft,
  type CarStep,
} from "../../garage/car-picker";
import { carTitle, type CarLevel, type GarageCar } from "../../garage/garage";
import { useVehicleModifications } from "../../services/use-vehicles";
import { useGarage } from "../../state/garage-provider";
import { useT } from "../../state/language";
import { ColorSheet } from "./ColorSheet";

const STEP_TEXT = {
  make: "car.step.make",
  model: "car.step.model",
  year: "car.step.year",
  generation: "car.step.generation",
  body: "car.step.body",
  engine: "car.step.engine",
  transmission: "car.step.transmission",
  drive: "car.step.drive",
} as const satisfies Record<CarStep, string>;

const LEVEL_TEXT = {
  make: "car.level.make",
  model: "car.level.model",
  year: "car.level.year",
  generation: "car.level.generation",
  body: "car.level.body",
  engine: "car.level.engine",
  transmission: "car.level.transmission",
  drive: "car.level.drive",
} as const satisfies Record<CarLevel, string>;

export interface CarSummaryViewProps {
  /** The vehicle-catalog levels as they stood when the final step opened. */
  draft: CarDraft;
  /** The colour the car had (editing) or `null` (a new car). */
  color: CarColorId | null;
  /** The car being completed or edited. */
  car?: GarageCar;
  isActive: () => boolean;
  /** A row was tapped and the warning, if any, was accepted: open its step. */
  onEditLevel: (level: CarLevel, draft: CarDraft) => void;
  onBack: () => void;
  onSaved: (car: GarageCar) => void;
}

/**
 * The final step of adding or completing a car (TASK-028.B, requirement 3):
 * every parameter, set or not, in one list — a make chosen by hand and a
 * body taken automatically because it was the only one look exactly alike,
 * because a person is meant to see both the same way and be able to change
 * either. Colour (D-063) is one more row of the very same list, picked from
 * its own sheet rather than a step, since it never gates anything below it.
 *
 * This screen does not know, and does not need to know, whether a value here
 * came from a step already answered or was filled in some other way — which
 * is exactly what lets it take recognised техпаспорт fields later (TASK-057)
 * without being rebuilt: whatever hands it a `draft` and a `color` is enough.
 */
export function CarSummaryView({
  draft,
  color,
  car,
  isActive,
  onEditLevel,
  onBack,
  onSaved,
}: CarSummaryViewProps) {
  const t = useT();
  const toast = useToast();
  const garage = useGarage();

  const [pickedColor, setPickedColor] = useState<CarColorId | null>(color);
  const [colorSheet, setColorSheet] = useState(false);
  const [confirmReset, setConfirmReset] = useState<CarLevel | null>(null);
  const [duplicate, setDuplicate] = useState<GarageCar | null>(null);
  const afterDialog = useAfterDismiss(confirmReset !== null || duplicate !== null);

  // Stable across re-renders: a new id and timestamp must be picked once,
  // when the screen opens, not on every render this component draws before
  // it is saved (or never, if it is only ever looked at and left).
  const [id] = useState(() => car?.id ?? garage.nextId());
  const [addedAt] = useState(() => car?.addedAt ?? new Date().toISOString());

  // The single modification the chosen levels name, if any — the same
  // request the last step already made, so this is normally already in its
  // 60-second cache (`services/use-vehicles.ts`) and costs no extra wait.
  const modifications = useVehicleModifications(draft.generation?.id ?? null);

  const build = (finalColor: CarColorId | null) =>
    draftToCar(draft, {
      id,
      addedAt,
      modifications: modifications.data?.modifications ?? [],
      color: finalColor,
    });

  const commit = (built: GarageCar) => {
    if (!isActive()) return;
    if (car) garage.update(built);
    else garage.add(built);
    toast.show(t("garage.added"));
    onSaved(built);
  };

  const save = () => {
    if (!isActive()) return;
    const built = build(pickedColor);
    if (!built) return;
    const existing = garage.duplicateOf(built);
    if (existing) {
      setDuplicate(existing);
      return;
    }
    commit(built);
  };

  const saveAnyway = () => {
    const built = build(pickedColor);
    setDuplicate(null);
    if (built) afterDialog.after(() => commit(built));
  };

  const editLevel = (level: CarLevel) => {
    if (!isActive()) return;
    if (levelsClearedBy(draft, level).length > 0) {
      setConfirmReset(level);
      return;
    }
    onEditLevel(level, draft);
  };

  const rows = summaryRows(draft);

  return (
    <Screen
      title={t("car.summary.title")}
      back={{ label: t("common.back"), onPress: onBack }}
      footer={<Button onPress={save}>{t("car.summary.save")}</Button>}
    >
      <View style={styles.content}>
        <Text variant="bodyS" color="textMuted">
          {t("car.summary.text")}
        </Text>
        <ListGroup>
          {rows.map((row, index) => (
            <ListRow
              key={row.level}
              first={index === 0}
              title={t(STEP_TEXT[row.level])}
              subtitle={row.label ?? t("common.notSet")}
              trailing={
                row.label === null ? (
                  <Text variant="bodyS" color="accent">
                    {t("garage.complete")}
                  </Text>
                ) : null
              }
              onPress={() => editLevel(row.level)}
            />
          ))}
          <ListRow
            title={t("car.step.color")}
            subtitle={pickedColor === null ? t("common.notSet") : t(`car.color.${pickedColor}`)}
            trailing={
              pickedColor === null ? (
                <Text variant="bodyS" color="accent">
                  {t("garage.complete")}
                </Text>
              ) : null
            }
            onPress={() => setColorSheet(true)}
          />
        </ListGroup>
      </View>

      <Dialog
        visible={confirmReset !== null}
        onClose={() => setConfirmReset(null)}
        onDismissed={afterDialog.onDismissed}
        title={t("car.resetTitle")}
        actions={
          <>
            <Button
              onPress={() => {
                const level = confirmReset;
                setConfirmReset(null);
                if (level) afterDialog.after(() => onEditLevel(level, draft));
              }}
            >
              {t("common.continue")}
            </Button>
            <Button variant="secondary" onPress={() => setConfirmReset(null)}>
              {t("common.cancel")}
            </Button>
          </>
        }
      >
        {t("car.resetText", {
          levels: (confirmReset ? levelsClearedBy(draft, confirmReset) : [])
            .map((level) => t(LEVEL_TEXT[level]))
            .join(", "),
        })}
      </Dialog>

      <Dialog
        visible={duplicate !== null}
        onClose={() => setDuplicate(null)}
        onDismissed={afterDialog.onDismissed}
        title={t("car.duplicateTitle")}
        actions={
          <>
            <Button onPress={saveAnyway}>{t("car.duplicateAdd")}</Button>
            <Button variant="secondary" onPress={() => setDuplicate(null)}>
              {t("common.cancel")}
            </Button>
          </>
        }
      >
        {duplicate ? carTitle(duplicate) : ""}
      </Dialog>

      <ColorSheet
        visible={colorSheet}
        onClose={() => setColorSheet(false)}
        value={pickedColor}
        onPick={setPickedColor}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: layout.screenPadding, paddingTop: 12, gap: 12 },
});
