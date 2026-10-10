import type { VehicleDocumentAttempts, VehicleDocumentResponse } from "@adclub/contracts";
import { formatKzPlate } from "@adclub/domain";
import { layout, radius } from "@adclub/ui-core";
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import {
  Button,
  Dialog,
  EmptyState,
  Icon,
  Screen,
  Text,
  useAfterDismiss,
  useLoadingGate,
  useTheme,
  useToast,
} from "../../design-system";
import { EMPTY_DRAFT } from "../../garage/car-picker";
import {
  confirmationMerge,
  recognitionFailureOf,
  recognitionResultFailure,
  recognitionStart,
  type ConfirmationMerge,
  type RecognitionFailure,
} from "../../garage/document-flow";
import { listFallback, useListFallback } from "../../garage/list-fallback";

import { useCarAdding } from "../../navigation/car-adding";
import type { RootParams } from "../../navigation/routes";
import { useOnline } from "../../services/use-network";
import {
  documentAttempts,
  preparedSnapshot,
  recognizeDocument,
} from "../../services/vehicle-document";
import { useGarage } from "../../state/garage-provider";
import { useT } from "../../state/language";
import { garageErrorText } from "./garage-errors";

type Phase =
  { kind: "camera" } | { kind: "busy" } | { kind: "failed"; failure: RecognitionFailure };

type Outcome = { ok: true; answer: VehicleDocumentResponse } | { ok: false; error: unknown };

const FAILURE_TEXT: Record<
  RecognitionFailure,
  {
    title:
      | "doc.failedTitle"
      | "doc.unavailableTitle"
      | "doc.limitTitle"
      | "garage.needsNetwork"
      | "doc.invalidTitle";
    text:
      | "doc.failedText"
      | "doc.otherText"
      | "doc.unavailableText"
      | "doc.limit"
      | "doc.offlineText"
      | "doc.invalidText";
    retake: boolean;
  }
> = {
  not_readable: { title: "doc.failedTitle", text: "doc.failedText", retake: true },
  other_document: { title: "doc.failedTitle", text: "doc.otherText", retake: true },
  unavailable: { title: "doc.unavailableTitle", text: "doc.unavailableText", retake: false },
  limit: { title: "doc.limitTitle", text: "doc.limit", retake: false },
  offline: { title: "garage.needsNetwork", text: "doc.offlineText", retake: true },
  invalid: { title: "doc.invalidTitle", text: "doc.invalidText", retake: true },
};

/**
 * M-GAR-04 — the photo of the registration certificate (D-064, TASK-057).
 *
 * The camera with a frame and a hint, «Из галереи», T-GAR-02 before the
 * photo — the working consent until TASK-072 — and, for a guest, T-GAR-04
 * with the attempts left. The photo is made smaller on the phone and sent;
 * «Распознаём…» follows the rule of loading without flicker (D-069). A
 * certificate opens the steps with what was read (M-GAR-05); everything
 * else is a state of this screen with «Переснять» and — for adding —
 * «Выбрать из списка» (T-GAR-06).
 *
 * With `carId` it is «Подтвердить техпаспортом» of a car of the garage: the
 * mark becomes «документ показан», an empty VIN or plate is filled, and a
 * different one is asked about.
 *
 * An answer that arrives after the person left the screen, or after they
 * started again, belongs to no one and is dropped — it never fills a choice
 * that is not waiting for it.
 */
export function CarDocumentScreen({
  route,
  navigation,
}: NativeStackScreenProps<RootParams, "car-document">) {
  const { origin, carId, picked } = route.params;
  const t = useT();
  const toast = useToast();
  const { theme } = useTheme();
  const garage = useGarage();
  const online = useOnline();
  const adding = useCarAdding(origin);
  const listAllowed = useListFallback();
  const car = carId ? garage.cars.find((item) => item.id === carId) : undefined;
  const confirming = carId !== undefined;

  const [permission, requestPermission] = useCameraPermissions();
  const [cameraBroken, setCameraBroken] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: picked ? "busy" : "camera" });
  const [attempts, setAttempts] = useState<VehicleDocumentAttempts | null>(null);
  const [conflict, setConflict] = useState<{
    answer: VehicleDocumentResponse;
    merge: ConfirmationMerge;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const afterDialog = useAfterDismiss(conflict !== null);
  const camera = useRef<CameraView>(null);
  const gate = useLoadingGate();
  /** The recognition in flight; any other answer is stale. */
  const generation = useRef(0);

  const cameraUsable = permission?.granted === true && !cameraBroken;
  const cameraDenied =
    permission !== null && (cameraBroken || (!permission.granted && !permission.canAskAgain));

  // The system asks for the camera when the screen that needs it opens —
  // the person tapped «Сфотографировать техпаспорт» to get here.
  const asked = useRef(false);
  useEffect(() => {
    if (picked || asked.current || !permission || permission.granted || !permission.canAskAgain) {
      return;
    }
    asked.current = true;
    void requestPermission();
  }, [permission, picked, requestPermission]);

  // No camera: the gallery and the list are the ways left (M-GAR-04).
  useEffect(() => {
    if (cameraDenied && !confirming) listFallback.allow();
  }, [cameraDenied, confirming]);

  // T-GAR-04: a guest sees the trial recognitions left before the photo.
  useFocusEffect(
    useCallback(() => {
      if (garage.remote) return undefined;
      let live = true;
      documentAttempts()
        .then((value) => live && setAttempts(value))
        .catch(() => undefined);
      return () => {
        live = false;
      };
    }, [garage.remote]),
  );

  // Leaving the screen makes every answer still on its way a stale one.
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  const fail = (failure: RecognitionFailure) => {
    if (!confirming) listFallback.allow();
    setPhase({ kind: "failed", failure });
  };

  const confirmWith = async (
    answer: VehicleDocumentResponse,
    take: boolean,
    merge: ConfirmationMerge,
  ) => {
    if (!car) return;
    const read = (field: "vin" | "plate") =>
      merge.fill[field] ??
      (take ? merge.conflicts.find((item) => item.field === field)?.read : undefined);
    setSaving(true);
    try {
      await garage.update({
        ...car,
        vin: read("vin") ?? car.vin,
        plate: read("plate") ?? car.plate,
        document: {
          status: "shown",
          at: new Date().toISOString(),
          proof: answer.documentProof ?? "",
        },
      });
      toast.show(t("car.documentUpdated"));
      navigation.goBack();
    } catch (error) {
      toast.show(garageErrorText(error, t));
      setPhase({ kind: "camera" });
    } finally {
      setSaving(false);
    }
  };

  const apply = (outcome: Outcome) => {
    if (!outcome.ok) {
      const details = (outcome.error as { details?: { attempts?: VehicleDocumentAttempts } })
        ?.details;
      if (details?.attempts) setAttempts(details.attempts);
      fail(recognitionFailureOf(outcome.error));
      return;
    }
    const { answer } = outcome;
    setAttempts(answer.attempts);
    const failure = recognitionResultFailure(answer);
    if (failure) {
      fail(failure);
      return;
    }
    if (confirming) {
      if (!car) {
        navigation.goBack();
        return;
      }
      const merge = confirmationMerge(car, answer.fields);
      if (merge.conflicts.length > 0) {
        setConflict({ answer, merge });
        return;
      }
      void confirmWith(answer, true, merge);
      return;
    }
    const start = recognitionStart(answer);
    setPhase({ kind: "camera" });
    // This screen stays under the steps: «назад» from the first of them is «Переснять».
    navigation.push("car-step", { origin, draft: start.draft, recognition: start.recognition });
  };

  const recognize = async (
    source: { uri: string; width?: number; height?: number },
    ownFile: boolean,
  ) => {
    if (!online) {
      fail("offline");
      return;
    }
    generation.current += 1;
    const token = generation.current;
    setPhase({ kind: "busy" });
    const ticket = gate.begin();
    let outcome: Outcome;
    try {
      const bytes = await preparedSnapshot(source, ownFile);
      outcome = { ok: true, answer: await recognizeDocument(bytes) };
    } catch (error) {
      outcome = { ok: false, error };
    }
    if (token !== generation.current || !navigation.isFocused()) {
      gate.cancel();
      return;
    }
    gate.settle(ticket, () => apply(outcome));
  };

  // A photo the gallery gave before this screen opened.
  const pickedOnce = useRef(false);
  useEffect(() => {
    if (!picked || pickedOnce.current) return;
    pickedOnce.current = true;
    void recognize(picked, true);
    // `recognize` reads the current state when it runs; only the photo matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked]);

  const shoot = async () => {
    if (!camera.current || phase.kind !== "camera") return;
    let photo;
    try {
      photo = await camera.current.takePictureAsync({ quality: 0.9, exif: false });
    } catch {
      setCameraBroken(true);
      return;
    }
    if (photo) await recognize(photo, true);
  };

  const fromGallery = () =>
    void adding.pick().then((photo) => {
      if (photo) void recognize(photo, false);
    });

  const chooseFromList = () => {
    if (!navigation.isFocused()) return;
    navigation.replace("car-step", { origin, draft: EMPTY_DRAFT, unconfirmed: true });
  };

  const busy = phase.kind === "busy";
  const listButton = !confirming && (listAllowed || phase.kind === "failed") && (
    <View style={styles.listBlock}>
      <Button variant="secondary" onPress={chooseFromList} disabled={busy}>
        {t("doc.chooseFromList")}
      </Button>
      <Text variant="caption" color="textMuted" style={styles.center}>
        {t("doc.listNote")}
      </Text>
    </View>
  );

  const failed = phase.kind === "failed" ? FAILURE_TEXT[phase.failure] : null;

  return (
    <Screen
      title={t(confirming ? "car.confirmDocument" : "doc.title")}
      back={{
        label: t("common.back"),
        onPress: () => navigation.isFocused() && navigation.goBack(),
      }}
      footer={
        phase.kind === "camera" ? (
          <View style={styles.footer}>
            {cameraUsable && (
              <Button icon="scan" onPress={() => void shoot()} disabled={!cameraReady}>
                {t("doc.shoot")}
              </Button>
            )}
            <Button variant={cameraUsable ? "secondary" : "primary"} onPress={fromGallery}>
              {t("doc.gallery")}
            </Button>
            {listButton}
          </View>
        ) : failed ? (
          <View style={styles.footer}>
            {failed.retake && (
              <Button onPress={() => setPhase({ kind: "camera" })}>{t("doc.retake")}</Button>
            )}
            {confirming ? (
              <Button variant="secondary" onPress={() => navigation.goBack()}>
                {t("common.back")}
              </Button>
            ) : (
              listButton
            )}
          </View>
        ) : null
      }
    >
      <View style={styles.content}>
        {phase.kind === "camera" && (
          <>
            {cameraUsable ? (
              <View style={[styles.camera, { backgroundColor: theme.colors.fill }]}>
                <CameraView
                  ref={camera}
                  style={StyleSheet.absoluteFill}
                  facing="back"
                  onCameraReady={() => setCameraReady(true)}
                  onMountError={() => setCameraBroken(true)}
                />
                <View pointerEvents="none" style={styles.overlay}>
                  <View style={styles.frame} />
                  <Text variant="bodyS" style={styles.hint}>
                    {t("doc.hint")}
                  </Text>
                </View>
              </View>
            ) : cameraDenied ? (
              <EmptyState
                icon="cameraSlash"
                title={t("doc.cameraDeniedTitle")}
                text={t("doc.cameraDeniedText")}
                action={
                  permission?.canAskAgain && !cameraBroken ? (
                    <Button variant="secondary" size="m" onPress={() => void requestPermission()}>
                      {t("doc.cameraAllow")}
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <View style={[styles.camera, { backgroundColor: theme.colors.fill }]} />
            )}
            <Text variant="bodyS" color="textMuted">
              {t("doc.privacy")}
            </Text>
            {attempts?.scope === "guest" && (
              <Text variant="bodyS" color="textMuted">
                {t("doc.attemptsLeft", { count: attempts.remaining })}
              </Text>
            )}
          </>
        )}

        {busy && gate.indicator && (
          <View style={styles.busy} accessibilityLiveRegion="polite">
            <Icon name="sparkles" size={32} color="ai" />
            <Text color="textMuted">{t("doc.recognizing")}</Text>
          </View>
        )}

        {failed && (
          <EmptyState
            icon={
              phase.kind === "failed" && phase.failure === "offline" ? "wifiOff" : "alertTriangle"
            }
            title={t(failed.title)}
            text={t(failed.text)}
          />
        )}
        {phase.kind === "failed" && attempts?.scope === "guest" && phase.failure !== "limit" && (
          <Text variant="bodyS" color="textMuted" style={styles.center}>
            {t("doc.attemptsLeft", { count: attempts.remaining })}
          </Text>
        )}
      </View>

      <Dialog
        visible={conflict !== null}
        onClose={() => setConflict(null)}
        onDismissed={afterDialog.onDismissed}
        title={t("car.conflictTitle")}
        actions={
          <>
            <Button
              loading={saving}
              onPress={() => {
                const value = conflict;
                setConflict(null);
                if (value)
                  afterDialog.after(() => void confirmWith(value.answer, true, value.merge));
              }}
            >
              {t("car.takeDocument")}
            </Button>
            <Button
              variant="secondary"
              onPress={() => {
                const value = conflict;
                setConflict(null);
                if (value)
                  afterDialog.after(() => void confirmWith(value.answer, false, value.merge));
              }}
            >
              {t("car.keepMine")}
            </Button>
          </>
        }
      >
        {(conflict?.merge.conflicts ?? [])
          .map((item) =>
            t("car.conflictLine", {
              field: t(item.field === "vin" ? "car.vin" : "car.plate"),
              current: item.field === "plate" ? formatKzPlate(item.current) : item.current,
              read: item.field === "plate" ? formatKzPlate(item.read) : item.read,
            }),
          )
          .join("\n")}
      </Dialog>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: layout.screenPadding, paddingTop: 12, gap: 12 },
  camera: {
    width: "100%",
    aspectRatio: 3 / 4,
    borderRadius: radius.m,
    overflow: "hidden",
  },
  overlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    padding: 16,
  },
  frame: {
    width: "88%",
    aspectRatio: 86 / 54,
    borderWidth: 2,
    borderColor: "#FFFFFF",
    borderRadius: radius.m,
  },
  hint: {
    color: "#FFFFFF",
    textAlign: "center",
    textShadowColor: "rgba(0,0,0,0.6)",
    textShadowRadius: 4,
  },
  busy: { alignItems: "center", gap: 12, paddingVertical: 48 },
  footer: { gap: 8 },
  listBlock: { gap: 8 },
  center: { textAlign: "center" },
});
