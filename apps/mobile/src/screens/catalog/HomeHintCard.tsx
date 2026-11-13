import type { GarageReminder, GarageReminderCar, GarageRemindersResponse } from "@adclub/contracts";
import { isMileageInRange, parseMileageInput } from "@adclub/domain";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useState } from "react";
import { StyleSheet, View } from "react-native";
import {
  Banner,
  Button,
  Dialog,
  Text,
  TextField,
  useAfterDismiss,
  useToast,
} from "../../design-system";
import { carTitle, type GarageCar } from "../../garage/garage";
import { formatKm, lowerThanLast } from "../../garage/mileage";
import { homeCardOf, reminderTextOf, withCar } from "../../garage/reminder-card";
import { apiClient } from "../../services/api";
import { useOnline } from "../../services/use-network";
import { useRequest } from "../../services/use-request";
import { useGarage } from "../../state/garage-provider";
import { useLanguage } from "../../state/language";
import { useSession } from "../../state/session-provider";
import { garageErrorText } from "../garage/garage-errors";

export interface HomeHintCardProps {
  car: GarageCar;
  /** «Уточните двигатель» opens the car at that step. */
  onCompleteEngine: (car: GarageCar) => void;
  /** «Подобрать»: the subcategory with the rule's filters (the answer of the plan). */
  onPick: (reminder: GarageReminder) => void;
  /** The camera of M-REM-02: the photo of the dashboard (M-GAR-07, TASK-058). */
  onMileagePhoto: (car: GarageCar) => void;
}

/**
 * The one hint card of M-CAT-01 by the order of SCREENS (TASK-069):
 * «Уточните двигатель» → M-REM-02 «Какой сейчас пробег…» → M-REM-01 «Пора
 * менять…». The reminders are the server's (`GET /garage/reminders`, the
 * one rule `reminderState`): only for a signed-in person with M-PRO-04 on,
 * only for the car of the header; the app counts nothing.
 */
export function HomeHintCard({ car, onCompleteEngine, onPick, onMileagePhoto }: HomeHintCardProps) {
  const { t, tn, lang } = useLanguage();
  const online = useOnline();
  const session = useSession();
  const garage = useGarage();
  const toast = useToast();
  const signedIn = session.status === "signed_in";
  const enabled = signedIn && session.profile?.remindersEnabled !== false;

  // The answer follows the car, its engine and its mileage: a new reading counts anew.
  const request = useRequest<GarageRemindersResponse>(
    enabled && car.engine !== null
      ? `reminders:${session.accountId ?? ""}:${lang}:${car.id}:${car.engine.id}:${String(car.mileage?.valueKm ?? "")}`
      : null,
    (signal) => apiClient.listGarageReminders({ signal }),
    { staleAfterMs: 60_000 },
  );
  // An action's answer is shown at once, until the next answer of the list.
  // Kept with the answer it was made over: a newer answer of the list replaces it.
  const [answered, setAnswered] = useState<{
    over: GarageRemindersResponse | null;
    value: GarageRemindersResponse | null;
  } | null>(null);
  useFocusEffect(
    useCallback(() => {
      request.reloadIfStale();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );
  const reminders = answered && answered.over === request.data ? answered.value : request.data;
  const card = homeCardOf(car, enabled ? reminders : null);

  const [mileage, setMileage] = useState("");
  const [mileageError, setMileageError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<GarageReminder | null>(null);
  const [doneKm, setDoneKm] = useState("");
  const [doneError, setDoneError] = useState<string | undefined>();
  const [lower, setLower] = useState<{ lastKm: number; send: () => Promise<void> } | null>(null);
  const afterDone = useAfterDismiss(done !== null);
  const afterLower = useAfterDismiss(lower !== null);

  if (!card) return null;
  const title = carTitle(car);
  const offlineNote = !online ? (
    <Text variant="caption" color="textMuted">
      {t("garage.needsNetwork")}
    </Text>
  ) : null;

  const apply = (next: GarageReminderCar) =>
    setAnswered({ over: request.data, value: withCar(reminders, next) });

  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      const lastKm = lowerThanLast(error);
      if (lastKm === null) toast.show(garageErrorText(error, t));
      else throw error;
    } finally {
      setBusy(false);
    }
  };

  if (card.kind === "engine") {
    return (
      <View style={styles.wrap}>
        <Banner
          tone="warning"
          action={
            <Button variant="text" size="m" onPress={() => onCompleteEngine(car)}>
              {t("compat.completeCar")}
            </Button>
          }
        >
          {t("catalog.hintRefineEngine")}
        </Banner>
      </View>
    );
  }

  if (card.kind === "mileage") {
    const save = async (confirmLower: boolean) => {
      const km = parseMileageInput(mileage);
      if (km === null || !isMileageInRange(km)) {
        setMileageError(t("mileage.invalid"));
        return;
      }
      setBusy(true);
      try {
        await garage.recordMileage(car.id, { valueKm: km, source: "text" }, confirmLower);
        setMileage("");
        toast.show(t("mileage.saved"));
        request.reload();
      } catch (error) {
        const lastKm = lowerThanLast(error);
        if (lastKm !== null) setLower({ lastKm, send: () => save(true) });
        else toast.show(garageErrorText(error, t));
      } finally {
        setBusy(false);
      }
    };
    return (
      <View style={styles.wrap}>
        <Banner tone="neutral" icon="car">
          {t("mileageAsk.title", { car: title })}
        </Banner>
        <View style={styles.form}>
          <TextField
            label={t("mileage.field")}
            value={mileage}
            onChangeText={(next) => {
              setMileage(next);
              setMileageError(undefined);
            }}
            keyboardType="number-pad"
            inputMode="numeric"
            {...(mileageError ? { error: mileageError } : {})}
          />
          <View style={styles.column}>
            <Button size="m" onPress={() => void save(false)} loading={busy} disabled={!online}>
              {t("mileageAsk.save")}
            </Button>
            <Button size="m" variant="secondary" icon="camera" onPress={() => onMileagePhoto(car)}>
              {t("mileage.photo")}
            </Button>
            <Button
              size="m"
              variant="text"
              disabled={!online || busy}
              onPress={() =>
                void act(async () =>
                  apply(await apiClient.dismissGarageMileageQuestion({ carId: car.id })),
                )
              }
            >
              {t("mileageAsk.later")}
            </Button>
          </View>
          {offlineNote}
        </View>
        <LowerDialog lower={lower} onClose={() => setLower(null)} after={afterLower} />
      </View>
    );
  }

  const reminder = card.reminder;
  const text = reminderTextOf(reminder, title);
  const message = text.plural ? tn(text.key, text.count, text.params) : t(text.key, text.params);
  const catalog = reminder.catalog;
  const canPick = catalog !== null && !catalog.unavailable && catalog.categoryId !== null;

  const markDone = async (confirmLower: boolean) => {
    const typed = doneKm.trim() === "" ? null : parseMileageInput(doneKm);
    if (doneKm.trim() !== "" && (typed === null || !isMileageInRange(typed))) {
      setDoneError(t("mileage.invalid"));
      return;
    }
    // The same as the server counted: nothing to write to the journal.
    const corrected = typed !== null && typed !== currentKmOf(reminders, car.id) ? typed : null;
    setBusy(true);
    try {
      const next = await apiClient.markGarageReminderDone(
        { carId: car.id, planItemId: reminder.planItemId },
        corrected === null
          ? {}
          : { mileageKm: corrected, ...(confirmLower ? { confirmLower } : {}) },
      );
      apply(next);
      setDone(null);
      toast.show(t("reminder.doneSaved"));
      // The journal may have a new reading: the copy of the garage follows.
      if (corrected !== null) void garage.sync();
    } catch (error) {
      const lastKm = lowerThanLast(error);
      if (lastKm !== null) {
        setDone(null);
        afterDone.after(() => setLower({ lastKm, send: () => markDone(true) }));
      } else {
        toast.show(garageErrorText(error, t));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.wrap}>
      <Banner tone="neutral" icon="wrench">
        {message}
      </Banner>
      <View style={styles.actions}>
        {canPick && (
          <Button size="m" onPress={() => onPick(reminder)} disabled={!online}>
            {t("reminder.pick")}
          </Button>
        )}
        <Button
          size="m"
          variant="secondary"
          disabled={!online || busy}
          onPress={() => {
            const km = currentKmOf(reminders, car.id);
            setDoneKm(km === null ? "" : String(km));
            setDoneError(undefined);
            setDone(reminder);
          }}
        >
          {t("reminder.done")}
        </Button>
        <Button
          size="m"
          variant="text"
          disabled={!online || busy}
          onPress={() =>
            void act(async () => {
              apply(
                await apiClient.snoozeGarageReminder({
                  carId: car.id,
                  planItemId: reminder.planItemId,
                }),
              );
              toast.show(t("reminder.snoozedToast"));
            })
          }
        >
          {t("reminder.later")}
        </Button>
      </View>
      {offlineNote}
      <Dialog
        visible={done !== null}
        onClose={() => setDone(null)}
        onDismissed={afterDone.onDismissed}
        title={t("reminder.doneTitle")}
        actions={
          <>
            <Button onPress={() => void markDone(false)} loading={busy} disabled={!online}>
              {t("reminder.doneConfirm")}
            </Button>
            <Button variant="secondary" onPress={() => setDone(null)}>
              {t("common.cancel")}
            </Button>
          </>
        }
      >
        <View style={styles.form}>
          <Text variant="bodyS" color="textMuted">
            {t("reminder.doneText")}
          </Text>
          <TextField
            label={t("reminder.doneField")}
            value={doneKm}
            onChangeText={(next) => {
              setDoneKm(next);
              setDoneError(undefined);
            }}
            keyboardType="number-pad"
            inputMode="numeric"
            {...(doneError ? { error: doneError } : {})}
          />
        </View>
      </Dialog>
      <LowerDialog lower={lower} onClose={() => setLower(null)} after={afterLower} />
    </View>
  );
}

function currentKmOf(reminders: GarageRemindersResponse | null, carId: string): number | null {
  return reminders?.cars.find((entry) => entry.carId === carId)?.currentKm ?? null;
}

/** «Меньше, чем в прошлый раз (N км). Всё верно?» — the rule of TASK-058. */
function LowerDialog({
  lower,
  onClose,
  after,
}: {
  lower: { lastKm: number; send: () => Promise<void> } | null;
  onClose: () => void;
  after: ReturnType<typeof useAfterDismiss>;
}) {
  const { t } = useLanguage();
  return (
    <Dialog
      visible={lower !== null}
      onClose={onClose}
      onDismissed={after.onDismissed}
      title={lower ? t("mileage.lowerTitle", { value: formatKm(lower.lastKm) }) : ""}
      actions={
        <>
          <Button
            onPress={() => {
              const asked = lower;
              onClose();
              if (asked) after.after(() => void asked.send());
            }}
          >
            {t("mileage.lowerConfirm")}
          </Button>
          <Button variant="secondary" onPress={onClose}>
            {t("mileage.lowerFix")}
          </Button>
        </>
      }
    >
      {null}
    </Dialog>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingBottom: 12 },
  form: { gap: 8, paddingTop: 8 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingTop: 8 },
  // M-REM-02: the field, then its actions one under another (a long Kazakh label fits).
  column: { gap: 8, alignItems: "stretch" },
});
