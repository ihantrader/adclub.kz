import { useState } from "react";
import { StyleSheet, View } from "react-native";
import {
  Badge,
  Button,
  Dialog,
  Icon,
  IconLine,
  ListGroup,
  ListRow,
  Screen,
  ScreenBody,
  Section,
  Text,
  TextField,
  useAfterDismiss,
  useTheme,
  useToast,
  ValueRow,
} from "../../design-system";
import { formatKzPlate } from "@adclub/domain";
import { joinDot } from "../../catalog/format";
import { findCarColor } from "../../garage/car-color";
import type { CarStep } from "../../garage/car-picker";
import { checkDocumentFields } from "../../garage/document-flow";
import {
  CAR_LEVELS,
  carParameters,
  carTitle,
  type CarLevel,
  type GarageCar,
} from "../../garage/garage";
import { whenDayText } from "../../orders/order-time";
import { useOnline } from "../../services/use-network";
import { useGarage } from "../../state/garage-provider";
import { useLanguage, useT } from "../../state/language";
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
  /** «Подтвердить техпаспортом» (TASK-057): the camera for this car. */
  onConfirm: () => void;
  onDeleted: () => void;
  onBack: () => void;
}

/**
 * M-GAR-06 — the card of a car (TASK-078): the car at the top — the icon,
 * the name `titleL`, its parameters in one line, the colour and «Основной» —
 * then the parameters as value rows, every one a step away («Не указано ·
 * Дополнить» for the missing ones), the registration certificate, and the
 * actions: «Сделать основным», and «Удалить автомобиль» in a block of its
 * own, a secondary button with the danger text (DESIGN 7.7: the button
 * names the action; the deletion asks first).
 *
 * Signed in, each of them is a change of the account's garage (TASK-029.B):
 * the button waits for the server, a refusal is said and changes nothing,
 * and without a network they are off with «Нужна сеть».
 */
export function CarCardView({ car, onEdit, onConfirm, onDeleted, onBack }: CarCardViewProps) {
  const t = useT();
  const toast = useToast();
  const { theme } = useTheme();
  const { state, remote, makePrimary, remove, update } = useGarage();
  const online = useOnline();
  const offline = remote && !online;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [colorSheet, setColorSheet] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editing, setEditing] = useState<"vin" | "plate" | null>(null);
  const [draftValue, setDraftValue] = useState("");
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const { t: tt } = useLanguage();
  const documentDate = (at: string) =>
    whenDayText(at, null, new Date(), {
      monthName: (month) => tt(`month.${month}` as "month.1"),
      today: tt("common.today"),
      yesterday: tt("common.yesterday"),
    }) ?? "";

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
  const parameters = joinDot(carParameters(car));
  const color = car.color !== null ? findCarColor(car.color) : undefined;
  const complete = t("garage.complete");
  const notSet = t("common.notSet");
  const needsNetwork = () => toast.show(t("garage.needsNetwork"));

  const documentStatus =
    car.document?.status === "shown"
      ? t("car.documentShown", { date: documentDate(car.document.at) })
      : car.document?.status === "unconfirmed"
        ? t("car.documentUnconfirmed")
        : t("car.documentNone");

  return (
    <Screen
      title={carTitle(car)}
      titleAfterScroll
      back={{ label: t("common.back"), onPress: onBack }}
    >
      <ScreenBody>
        <Section first>
          <View style={styles.head}>
            <Icon name="car" size={48} color="accent" />
            <Text variant="titleL" accessibilityRole="header">
              {carTitle(car)}
            </Text>
            {parameters !== "" && (
              <Text variant="bodyS" color="textMuted">
                {parameters}
              </Text>
            )}
            <View style={styles.headMarks}>
              {color && (
                <View style={styles.colorRow}>
                  <View
                    style={[
                      styles.swatch,
                      { backgroundColor: color.swatch, borderColor: theme.colors.borderField },
                    ]}
                  />
                  <Text variant="bodyS" color="textMuted">
                    {t(`car.color.${car.color!}`)}
                  </Text>
                </View>
              )}
              {primary && (
                <Badge tone="accent" icon="check">
                  {t("garage.primary")}
                </Badge>
              )}
            </View>
          </View>
        </Section>

        <Section title={t("garage.parameters")}>
          <ListGroup>
            {CAR_LEVELS.map((level, index) => {
              const value = levelValue(car, level);
              return (
                <ValueRow
                  key={level}
                  first={index === 0}
                  label={t(LEVEL_STEP_TEXT[level])}
                  value={value}
                  placeholder={notSet}
                  {...(value === null ? { action: complete } : {})}
                  navigates
                  onPress={() => onEdit(level)}
                />
              );
            })}
            {/* Colour (D-063): not a level of the vehicle catalog, so it is
                picked from its own sheet, not by opening a step — nothing
                below it in the list depends on it. */}
            <ValueRow
              label={t("car.step.color")}
              value={car.color === null ? null : t(`car.color.${car.color}`)}
              placeholder={notSet}
              {...(car.color === null ? { action: complete } : {})}
              navigates
              onPress={() => (offline ? needsNetwork() : setColorSheet(true))}
            />
          </ListGroup>
        </Section>

        {/* TASK-057 (D-064): the VIN, the plate and the mark of the document. */}
        <Section title={t("car.document")}>
          <ListGroup>
            {(["vin", "plate"] as const).map((field, index) => {
              const value = car[field];
              return (
                <ValueRow
                  key={field}
                  first={index === 0}
                  label={t(field === "vin" ? "car.vin" : "car.plate")}
                  value={value === null ? null : field === "plate" ? formatKzPlate(value) : value}
                  placeholder={notSet}
                  {...(value === null ? { action: complete } : {})}
                  navigates
                  onPress={() => {
                    if (offline) {
                      needsNetwork();
                      return;
                    }
                    setEditing(field);
                    setDraftValue(
                      value === null ? "" : field === "plate" ? formatKzPlate(value) : value,
                    );
                    setFieldError(undefined);
                  }}
                />
              );
            })}
            <ListRow
              title={
                <IconLine
                  icon={car.document?.status === "shown" ? "circleCheck" : "info"}
                  variant="body"
                  color={car.document?.status === "shown" ? "success" : "textMuted"}
                  textColor="text"
                >
                  {documentStatus}
                </IconLine>
              }
            />
          </ListGroup>
          {car.document?.status !== "shown" && (
            <Button variant="secondary" disabled={offline} onPress={onConfirm}>
              {t("car.confirmDocument")}
            </Button>
          )}
        </Section>

        {!primary && (
          <Section>
            <Button
              variant="secondary"
              disabled={offline}
              onPress={() => attempt(() => makePrimary(car.id))}
            >
              {t("garage.makePrimary")}
            </Button>
          </Section>
        )}

        <Section>
          <Button
            variant="secondary"
            destructive
            disabled={offline}
            loading={deleting}
            onPress={() => setConfirmDelete(true)}
          >
            {t("garage.delete")}
          </Button>
          {offline && (
            <Text variant="caption" color="textMuted">
              {t("garage.needsNetwork")}
            </Text>
          )}
        </Section>
      </ScreenBody>

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

      <Dialog
        visible={editing !== null}
        onClose={() => setEditing(null)}
        title={t(editing === "plate" ? "car.editPlate" : "car.editVin")}
        actions={
          <>
            <Button
              onPress={() => {
                const field = editing;
                if (!field) return;
                const checked = checkDocumentFields(
                  field === "vin" ? draftValue : "",
                  field === "plate" ? draftValue : "",
                );
                const error = checked.errors[field];
                if (error) {
                  setFieldError(
                    error === "vin_length"
                      ? t("car.vinLength")
                      : error === "vin_characters"
                        ? t("car.vinCharacters")
                        : t("car.plateInvalid"),
                  );
                  return;
                }
                setEditing(null);
                void attempt(() => update({ ...car, [field]: checked[field] }));
              }}
            >
              {t("common.save")}
            </Button>
            <Button variant="secondary" onPress={() => setEditing(null)}>
              {t("common.cancel")}
            </Button>
          </>
        }
      >
        <TextField
          label={t(editing === "plate" ? "car.plate" : "car.vin")}
          value={draftValue}
          onChangeText={(value) => {
            setDraftValue(value);
            setFieldError(undefined);
          }}
          autoCapitalize="characters"
          autoCorrect={false}
          {...(fieldError
            ? { error: fieldError }
            : { hint: t(editing === "plate" ? "car.plateRule" : "car.vinRule") })}
        />
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
  head: { gap: 8 },
  headMarks: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 12 },
  colorRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  swatch: { width: 14, height: 14, borderRadius: 7, borderWidth: 1 },
});
