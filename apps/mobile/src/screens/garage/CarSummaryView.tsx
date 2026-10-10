import { layout } from "@adclub/ui-core";
import { randomUUID } from "expo-crypto";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { formatKzPlate } from "@adclub/domain";
import {
  AiBadge,
  Button,
  Dialog,
  ListGroup,
  ListRow,
  Screen,
  Text,
  TextField,
  useAfterDismiss,
  useToast,
} from "../../design-system";
import {
  checkDocumentFields,
  stillRecognized,
  type CarRecognition,
  type DocumentFieldError,
} from "../../garage/document-flow";
import type { CarColorId } from "../../garage/car-color";
import {
  draftToCar,
  levelsClearedBy,
  summaryRows,
  type CarDraft,
  type CarStep,
} from "../../garage/car-picker";
import {
  carTitle,
  findVinHolder,
  type CarDocumentMark,
  type CarLevel,
  type GarageCar,
} from "../../garage/garage";
import { useOnline } from "../../services/use-network";
import { useVehicleModifications } from "../../services/use-vehicles";
import { useGarage } from "../../state/garage-provider";
import { useT } from "../../state/language";
import { ColorSheet } from "./ColorSheet";
import { garageErrorText } from "./garage-errors";

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
  /** What a photographed certificate brought (TASK-057, M-GAR-05). */
  recognition?: CarRecognition;
  /** Chosen from the list after recognition did not work: «документ не подтверждён». */
  unconfirmed?: boolean;
  /** «Переснять»: back to the camera. */
  onRetake?: () => void;
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
  recognition,
  unconfirmed,
  onRetake,
  isActive,
  onEditLevel,
  onBack,
  onSaved,
}: CarSummaryViewProps) {
  const t = useT();
  const toast = useToast();
  const garage = useGarage();
  const online = useOnline();
  // A signed-in person's car is saved in the account: without a network
  // there is nothing to save it to (TASK-029.B, no queue of changes).
  const offline = garage.remote && !online;

  const [pickedColor, setPickedColor] = useState<CarColorId | null>(color);
  const [colorSheet, setColorSheet] = useState(false);
  const [confirmReset, setConfirmReset] = useState<CarLevel | null>(null);
  const [duplicate, setDuplicate] = useState<GarageCar | null>(null);
  const [vinHolder, setVinHolder] = useState<GarageCar | null>(null);
  const afterDialog = useAfterDismiss(
    confirmReset !== null || duplicate !== null || vinHolder !== null,
  );

  // VIN and plate (TASK-057): read off the certificate, or the car's own;
  // marked «распознано» while they still say what was read.
  const readVin = recognition?.fields.vin ?? "";
  const readPlate = recognition?.fields.plate ? formatKzPlate(recognition.fields.plate) : "";
  const [vin, setVin] = useState(() => readVin || (car?.vin ?? ""));
  const [plate, setPlate] = useState(
    () => readPlate || (car?.plate ? formatKzPlate(car.plate) : ""),
  );
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<"vin" | "plate", DocumentFieldError>>
  >({});
  const fieldErrorText = (error: DocumentFieldError | undefined) =>
    error === "vin_length"
      ? t("car.vinLength")
      : error === "vin_characters"
        ? t("car.vinCharacters")
        : error === "plate"
          ? t("car.plateInvalid")
          : undefined;

  // Stable across re-renders: a new id and timestamp must be picked once,
  // when the screen opens, not on every render this component draws before
  // it is saved (or never, if it is only ever looked at and left).
  const [id] = useState(() => car?.id ?? garage.nextId());
  const [addedAt] = useState(() => car?.addedAt ?? new Date().toISOString());
  // One key per adding screen: «Сохранить» pressed again after an answer
  // was lost adds nothing new (ARCHITECTURE 4.46).
  const [idempotencyKey] = useState(() => randomUUID());

  // The single modification the chosen levels name, if any — the same
  // request the last step already made, so this is normally already in its
  // 60-second cache (`services/use-vehicles.ts`) and costs no extra wait.
  const modifications = useVehicleModifications(draft.generation?.id ?? null);

  // The mark the car is saved with (D-064): a certificate read — «показан»
  // with the server's proof; the list after a failure — «не подтверждён»;
  // a car being edited keeps its own.
  const [documentAt] = useState(() => new Date().toISOString());
  const document: CarDocumentMark | null = recognition
    ? { status: "shown", at: documentAt, proof: recognition.proof }
    : unconfirmed
      ? { status: "unconfirmed", at: documentAt }
      : (car?.document ?? null);

  const build = (finalColor: CarColorId | null) => {
    const checked = checkDocumentFields(vin, plate);
    return draftToCar(draft, {
      id,
      addedAt,
      modifications: modifications.data?.modifications ?? [],
      color: finalColor,
      vin: checked.vin,
      plate: checked.plate,
      document,
    });
  };

  const [saving, setSaving] = useState(false);

  /** Saved only once the server said so (signed in); a refusal leaves the screen as it was. */
  const commit = async (built: GarageCar) => {
    if (!isActive()) return;
    setSaving(true);
    try {
      const saved = car ? await garage.update(built) : await garage.add(built, idempotencyKey);
      toast.show(t("garage.added"));
      onSaved(saved);
    } catch (error) {
      toast.show(garageErrorText(error, t));
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    if (!isActive()) return;
    // T-GAR-07, checked as the server will check it.
    const checked = checkDocumentFields(vin, plate);
    setFieldErrors(checked.errors);
    if (Object.keys(checked.errors).length > 0) return;
    const built = build(pickedColor);
    if (!built) return;
    if (garage.remote) {
      // «Такой автомобиль уже есть» is asked about the account's garage as
      // it is now — another phone may have added the same car meanwhile.
      const synced = await garage.sync();
      if (synced.kind === "failed") {
        toast.show(garageErrorText(synced.error, t));
        return;
      }
    }
    // One VIN is one car (ARCHITECTURE 4.58): no «всё равно добавить».
    const holder = findVinHolder(garage.state, built);
    if (holder) {
      setVinHolder(holder);
      return;
    }
    const existing = garage.duplicateOf(built);
    if (existing) {
      setDuplicate(existing);
      return;
    }
    await commit(built);
  };

  const saveAnyway = () => {
    const built = build(pickedColor);
    setDuplicate(null);
    if (built) afterDialog.after(() => void commit(built));
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
      footer={
        <View style={styles.footer}>
          <Button onPress={save} loading={saving} disabled={offline}>
            {t("car.summary.save")}
          </Button>
          {recognition && onRetake && (
            <Button variant="secondary" onPress={onRetake} disabled={saving}>
              {t("doc.retake")}
            </Button>
          )}
          {offline && (
            <Text variant="caption" color="textMuted" style={styles.center}>
              {t("garage.needsNetwork")}
            </Text>
          )}
        </View>
      }
    >
      <View style={styles.content}>
        <Text variant="bodyS" color="textMuted">
          {/* T-GAR-03 when the values came off a certificate. */}
          {t(recognition ? "doc.check" : "car.summary.text")}
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
                ) : stillRecognized(recognition, draft, row.level) ? (
                  <AiBadge>{t("doc.recognized")}</AiBadge>
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
              ) : recognition?.color !== null && pickedColor === recognition?.color ? (
                <AiBadge>{t("doc.recognized")}</AiBadge>
              ) : null
            }
            onPress={() => setColorSheet(true)}
          />
        </ListGroup>
        <TextField
          label={t("car.vin")}
          value={vin}
          onChangeText={(value) => {
            setVin(value);
            setFieldErrors((errors) => ({ ...errors, vin: undefined }));
          }}
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={25}
          {...(readVin !== "" && vin === readVin ? { aiLabel: t("doc.recognized") } : {})}
          {...(fieldErrors.vin ? { error: fieldErrorText(fieldErrors.vin) } : {})}
        />
        <TextField
          label={t("car.plate")}
          value={plate}
          onChangeText={(value) => {
            setPlate(value);
            setFieldErrors((errors) => ({ ...errors, plate: undefined }));
          }}
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={15}
          {...(readPlate !== "" && plate === readPlate ? { aiLabel: t("doc.recognized") } : {})}
          {...(fieldErrors.plate
            ? { error: fieldErrorText(fieldErrors.plate) }
            : { hint: t("car.vinPlateRule") })}
        />
        {unconfirmed && (
          <Text variant="caption" color="textMuted">
            {t("doc.listNote")}
          </Text>
        )}
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

      <Dialog
        visible={vinHolder !== null}
        onClose={() => setVinHolder(null)}
        onDismissed={afterDialog.onDismissed}
        title={t("car.vinTaken")}
        actions={
          <Button variant="secondary" onPress={() => setVinHolder(null)}>
            {t("common.close")}
          </Button>
        }
      >
        {vinHolder ? t("car.vinTakenText", { car: carTitle(vinHolder) }) : ""}
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
  footer: { gap: 8 },
  center: { textAlign: "center" },
});
