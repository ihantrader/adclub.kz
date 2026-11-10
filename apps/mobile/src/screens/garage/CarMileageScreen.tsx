import type { VehicleDocumentAttempts } from "@adclub/contracts";
import { isMileageInRange, parseMileageInput } from "@adclub/domain";
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import {
  Button,
  Dialog,
  EmptyState,
  Icon,
  Screen,
  ScreenBody,
  Text,
  TextField,
  useAfterDismiss,
  useLoadingGate,
  useToast,
} from "../../design-system";
import { recognitionFailureOf, type RecognitionFailure } from "../../garage/document-flow";
import { carTitle } from "../../garage/garage";
import {
  dashboardOutcome,
  formatKm,
  lowerThanLast,
  type MileageReading,
} from "../../garage/mileage";
import type { RootParams } from "../../navigation/routes";
import { useOnline } from "../../services/use-network";
import {
  documentAttempts,
  pickFromGallery,
  preparedSnapshot,
  recognizeDashboard,
} from "../../services/vehicle-document";
import { useGarage } from "../../state/garage-provider";
import { useT } from "../../state/language";
import { CameraPanel, useCamera } from "../CameraPanel";
import { garageErrorText } from "./garage-errors";

/** What the photo read, held until the person saves it (M-GAR-05). */
interface Recognized {
  km: number;
  miles: boolean;
  recognitionId: string | null;
}

type Phase =
  | { kind: "input" }
  | { kind: "camera" }
  | { kind: "busy" }
  | { kind: "failed"; failure: RecognitionFailure };

const FAILURE_TEXT: Record<
  RecognitionFailure,
  {
    title:
      | "mileage.failedTitle"
      | "doc.unavailableTitle"
      | "doc.limitTitle"
      | "garage.needsNetwork"
      | "doc.invalidTitle";
    text:
      | "mileage.failedText"
      | "mileage.unavailableText"
      | "mileage.limitText"
      | "mileage.offlineText"
      | "doc.invalidText";
    retake: boolean;
  }
> = {
  not_readable: { title: "mileage.failedTitle", text: "mileage.failedText", retake: true },
  other_document: { title: "mileage.failedTitle", text: "mileage.failedText", retake: true },
  unavailable: { title: "doc.unavailableTitle", text: "mileage.unavailableText", retake: false },
  limit: { title: "doc.limitTitle", text: "mileage.limitText", retake: false },
  offline: { title: "garage.needsNetwork", text: "mileage.offlineText", retake: true },
  invalid: { title: "doc.invalidTitle", text: "doc.invalidText", retake: true },
};

/**
 * M-GAR-07 — the mileage of a car (TASK-058), and M-GAR-05 for it.
 *
 * - The field «Пробег, км» with the number keyboard and «Сохранить»; under
 *   it «Сфотографировать приборную панель» and «Из галереи» (a browser has
 *   no camera — the gallery only). No microphone: voice is TASK-059/060.
 * - A photo is made smaller on the phone, read by the server and forgotten;
 *   no thumbnail is shown (the snapshot is kept nowhere). The reading fills
 *   the field marked «распознано» (T-GAR-03) until the person changes it —
 *   «Всё верно, сохранить» writes it with what was read, «Переснять» takes
 *   another photo; miles are said («На панели мили — перевели в
 *   километры»).
 * - Not a dashboard, unreadable, unavailable, the trial over, offline: a
 *   state of this screen with «Ввести вручную».
 * - Lower than the last reading: «Меньше, чем в прошлый раз ({N} км). Всё
 *   верно?» — the server's answer for an account's car, the same rule on
 *   the device for a guest's.
 * - Signed in, saving needs the network («Нужна сеть»); a guest's reading is
 *   kept on the device and goes into the account with the car at sign-in.
 */
export function CarMileageScreen({
  route,
  navigation,
}: NativeStackScreenProps<RootParams, "car-mileage">) {
  const { carId } = route.params;
  const t = useT();
  const toast = useToast();
  const garage = useGarage();
  const online = useOnline();
  const car = garage.cars.find((item) => item.id === carId);

  const [phase, setPhase] = useState<Phase>({ kind: "input" });
  const { camera, cameraRef } = useCamera(phase.kind === "camera");
  const [value, setValue] = useState("");
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [recognized, setRecognized] = useState<Recognized | null>(null);
  const [attempts, setAttempts] = useState<VehicleDocumentAttempts | null>(null);
  const [lower, setLower] = useState<{ reading: MileageReading; lastKm: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const afterLower = useAfterDismiss(lower !== null);
  const gate = useLoadingGate();
  /** The recognition in flight; any other answer is stale. */
  const generation = useRef(0);

  // T-GAR-04: a guest sees the trial recognitions left (one count for every photo).
  useFocusEffect(
    useCallback(() => {
      if (garage.remote) return undefined;
      let live = true;
      documentAttempts()
        .then((answer) => live && setAttempts(answer))
        .catch(() => undefined);
      return () => {
        live = false;
      };
    }, [garage.remote]),
  );

  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  // The car left the garage (removed on another device): nothing to write to.
  if (!car) {
    return (
      <Screen
        title={t("mileage.title")}
        back={{ label: t("common.back"), onPress: () => navigation.goBack() }}
        centerContent
      >
        <EmptyState icon="car" title={t("car.needCarTitle")} />
      </Screen>
    );
  }

  // The field still holds what the photo read: «распознано» (SCREENS 9.3).
  const stillRecognized = recognized !== null && parseMileageInput(value) === recognized.km;

  const recognize = async (
    source: { uri: string; width?: number; height?: number },
    ownFile: boolean,
  ) => {
    if (!online) {
      setPhase({ kind: "failed", failure: "offline" });
      return;
    }
    generation.current += 1;
    const token = generation.current;
    setPhase({ kind: "busy" });
    const ticket = gate.begin();
    let apply: () => void;
    try {
      const bytes = await preparedSnapshot(source, ownFile);
      const answer = await recognizeDashboard(bytes);
      apply = () => {
        setAttempts(answer.attempts);
        const outcome = dashboardOutcome(answer);
        if (outcome.kind === "not_read") {
          setPhase({ kind: "failed", failure: "not_readable" });
          return;
        }
        setRecognized({
          km: outcome.km,
          miles: outcome.miles,
          recognitionId: outcome.recognitionId,
        });
        setValue(formatKm(outcome.km));
        setFieldError(undefined);
        setPhase({ kind: "input" });
      };
    } catch (error) {
      apply = () => {
        const details = (error as { details?: { attempts?: VehicleDocumentAttempts } })?.details;
        if (details?.attempts) setAttempts(details.attempts);
        setPhase({ kind: "failed", failure: recognitionFailureOf(error) });
      };
    }
    if (token !== generation.current || !navigation.isFocused()) {
      gate.cancel();
      return;
    }
    gate.settle(ticket, apply);
  };

  const shoot = async () => {
    const shot = await camera.shoot();
    if (shot) await recognize(shot, true);
  };

  const fromGallery = () =>
    void pickFromGallery()
      .then((picked) => {
        if (picked) void recognize(picked, false);
      })
      .catch(() => setPhase({ kind: "failed", failure: "invalid" }));

  const save = async (reading: MileageReading, confirmLower: boolean) => {
    setSaving(true);
    try {
      await garage.recordMileage(car.id, reading, confirmLower);
      toast.show(t("mileage.saved"));
      navigation.goBack();
    } catch (error) {
      const lastKm = lowerThanLast(error);
      if (lastKm !== null) setLower({ reading, lastKm });
      else toast.show(garageErrorText(error, t));
    } finally {
      setSaving(false);
    }
  };

  const submit = () => {
    const km = parseMileageInput(value);
    if (km === null || !isMileageInRange(km)) {
      setFieldError(t("mileage.invalid"));
      return;
    }
    const reading: MileageReading = recognized
      ? {
          valueKm: km,
          source: "photo",
          recognizedKm: recognized.km,
          recognitionId: recognized.recognitionId,
        }
      : { valueKm: km, source: "text" };
    void save(reading, false);
  };

  const offline = garage.remote && !online;
  const busy = phase.kind === "busy";
  const failed = phase.kind === "failed" ? FAILURE_TEXT[phase.failure] : null;
  const attemptsNote =
    attempts?.scope === "guest" && !(phase.kind === "failed" && phase.failure === "limit") ? (
      <Text variant="caption" color="textMuted" style={styles.center}>
        {t("doc.attemptsLeft", { count: attempts.remaining })}
      </Text>
    ) : null;
  const byHand = () => {
    setPhase({ kind: "input" });
  };

  return (
    <Screen
      title={t("mileage.title")}
      back={{
        label: t("common.back"),
        onPress: () => {
          if (!navigation.isFocused()) return;
          if (phase.kind === "camera" || phase.kind === "failed") setPhase({ kind: "input" });
          else navigation.goBack();
        },
      }}
      centerContent={phase.kind === "busy" || phase.kind === "failed"}
      footer={
        phase.kind === "input" ? (
          <View style={styles.footer}>
            <Button onPress={submit} loading={saving} disabled={offline}>
              {t(stillRecognized ? "doc.saveVerified" : "common.save")}
            </Button>
            {offline && (
              <Text variant="caption" color="textMuted" style={styles.center}>
                {t("garage.needsNetwork")}
              </Text>
            )}
          </View>
        ) : phase.kind === "camera" ? (
          <View style={styles.footer}>
            {attemptsNote}
            {camera.usable && (
              <Button onPress={() => void shoot()} disabled={!camera.ready}>
                {t("doc.shoot")}
              </Button>
            )}
            <Button variant={camera.usable ? "secondary" : "primary"} onPress={fromGallery}>
              {t("doc.gallery")}
            </Button>
            <Button variant="text" onPress={byHand}>
              {t("mileage.byHand")}
            </Button>
          </View>
        ) : failed ? (
          <View style={styles.footer}>
            {attemptsNote}
            {failed.retake && (
              <Button onPress={() => setPhase({ kind: "camera" })}>{t("doc.retake")}</Button>
            )}
            <Button variant={failed.retake ? "secondary" : "primary"} onPress={byHand}>
              {t("mileage.byHand")}
            </Button>
          </View>
        ) : null
      }
    >
      <ScreenBody>
        <View style={styles.stack}>
          {phase.kind === "input" && (
            <>
              <Text variant="bodyS" color="textMuted">
                {carTitle(car)}
              </Text>
              {stillRecognized && (
                <Text variant="bodyS" color="textMuted">
                  {t("doc.check")}
                </Text>
              )}
              <TextField
                label={t("mileage.field")}
                value={value}
                onChangeText={(next) => {
                  setValue(next);
                  setFieldError(undefined);
                }}
                keyboardType="number-pad"
                inputMode="numeric"
                autoFocus={recognized === null}
                {...(stillRecognized ? { aiLabel: t("doc.recognized") } : {})}
                {...(fieldError
                  ? { error: fieldError }
                  : {
                      hint:
                        stillRecognized && recognized?.miles
                          ? t("mileage.miles")
                          : car.mileage
                            ? t("car.mileageValue", {
                                value: formatKm(car.mileage.valueKm),
                                date: new Date(car.mileage.recordedAt).toLocaleDateString(),
                              })
                            : t("mileage.fieldHint"),
                    })}
              />
              <View style={styles.photoActions}>
                {recognized ? (
                  <Button
                    variant="secondary"
                    icon="camera"
                    onPress={() => setPhase({ kind: "camera" })}
                  >
                    {t("doc.retake")}
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    icon="camera"
                    onPress={() => setPhase({ kind: "camera" })}
                  >
                    {t("mileage.photo")}
                  </Button>
                )}
                <Button variant="secondary" onPress={fromGallery}>
                  {t("doc.gallery")}
                </Button>
              </View>
              {attemptsNote}
              <Text variant="caption" color="textMuted">
                {t("mileage.privacy")}
              </Text>
            </>
          )}

          {phase.kind === "camera" && (
            <>
              <CameraPanel
                camera={camera}
                cameraRef={cameraRef}
                hint={t("mileage.hint")}
                frame="wide"
              />
              <Text variant="bodyS" color="textMuted">
                {t("mileage.privacy")}
              </Text>
            </>
          )}

          {busy && gate.indicator && (
            <View style={styles.busy} accessibilityLiveRegion="polite">
              <Icon name="sparkles" size={32} color="ai" />
              <Text color="textMuted">{t("doc.recognizing")}</Text>
            </View>
          )}

          {failed && phase.kind === "failed" && (
            <EmptyState
              icon={phase.failure === "offline" ? "wifiOff" : "alertTriangle"}
              title={t(failed.title)}
              text={t(failed.text)}
            />
          )}
        </View>
      </ScreenBody>

      <Dialog
        visible={lower !== null}
        onClose={() => setLower(null)}
        onDismissed={afterLower.onDismissed}
        title={lower ? t("mileage.lowerTitle", { value: formatKm(lower.lastKm) }) : ""}
        actions={
          <>
            <Button
              onPress={() => {
                const asked = lower;
                setLower(null);
                if (asked) afterLower.after(() => void save(asked.reading, true));
              }}
            >
              {t("mileage.lowerConfirm")}
            </Button>
            <Button variant="secondary" onPress={() => setLower(null)}>
              {t("mileage.lowerFix")}
            </Button>
          </>
        }
      >
        {null}
      </Dialog>
    </Screen>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 12 },
  photoActions: { gap: 8 },
  busy: { alignItems: "center", gap: 12, paddingVertical: 48 },
  footer: { gap: 8 },
  center: { textAlign: "center" },
});
