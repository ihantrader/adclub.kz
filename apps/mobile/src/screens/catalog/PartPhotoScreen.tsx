import type { VehicleDocumentAttempts } from "@adclub/contracts";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import {
  Button,
  EmptyState,
  Icon,
  Screen,
  ScreenBody,
  Text,
  useLoadingGate,
} from "../../design-system";
import { useCatalogCar } from "../../catalog/catalog-car-provider";
import { partPhotoOutcome, type PartPhotoFound } from "../../catalog/part-photo";
import { vehicleQuery } from "../../catalog/vehicle-query";
import { recognitionFailureOf, type RecognitionFailure } from "../../garage/document-flow";
import { useSignIn } from "../../navigation/use-sign-in";
import { useOnline } from "../../services/use-network";
import {
  documentAttempts,
  pickFromGallery,
  preparedSnapshot,
  recognizePartPhoto,
} from "../../services/vehicle-document";
import { cityIdOf } from "../../state/city";
import { useCity } from "../../state/city-provider";
import { useGarage } from "../../state/garage-provider";
import { useT } from "../../state/language";
import { CameraPanel, useCamera } from "../CameraPanel";

type Phase =
  | { kind: "camera" }
  | { kind: "busy" }
  | { kind: "failed"; failure: RecognitionFailure | "no_article" };

export interface PartPhotoScreenProps {
  onBack: () => void;
  /** The article was read: the search with it, marked «распознан». */
  onFound: (found: PartPhotoFound) => void;
  /** «Ввести артикул»: the search line, empty and focused. */
  onTypeArticle: () => void;
}

/**
 * M-CAT-06 — a part by a photo of its article (TASK-058).
 *
 * The camera with «Снимите артикул на детали или упаковке», «Из галереи»
 * (a browser has no camera — the gallery only) and, for a guest, T-GAR-04:
 * the trial recognitions left — one count with the certificate and the
 * dashboard, so a guest who spent them on those sees «попытки закончились»
 * here at once and nothing is sent. The photo is made smaller on the phone,
 * read by the server and forgotten. An article opens the search with it;
 * «Не нашли артикул на фото» says how to take it better, with «Переснять»
 * and «Ввести артикул». No microphone: voice is TASK-059/060.
 */
export function PartPhotoScreen({ onBack, onFound, onTypeArticle }: PartPhotoScreenProps) {
  const t = useT();
  const online = useOnline();
  const signIn = useSignIn();
  const { remote } = useGarage();
  const { car } = useCatalogCar();
  const { selection } = useCity();
  const [phase, setPhase] = useState<Phase>({ kind: "camera" });
  const { camera, cameraRef } = useCamera(phase.kind === "camera");
  const [attempts, setAttempts] = useState<VehicleDocumentAttempts | null>(null);
  const gate = useLoadingGate();
  const generation = useRef(0);
  const focused = useRef(true);

  // T-GAR-04, and the trial already spent: said before any photo is taken.
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      let live = true;
      // Back from «Войти» signed in: the guest's spent trial is not this person's limit.
      if (remote) {
        setPhase((current) =>
          current.kind === "failed" && current.failure === "limit" ? { kind: "camera" } : current,
        );
        setAttempts(null);
      } else {
        documentAttempts()
          .then((answer) => {
            if (!live) return;
            setAttempts(answer);
            if (answer.scope === "guest" && answer.remaining === 0) {
              setPhase({ kind: "failed", failure: "limit" });
            }
          })
          .catch(() => undefined);
      }
      return () => {
        live = false;
        focused.current = false;
      };
    }, [remote]),
  );

  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

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
      const cityId = cityIdOf(selection);
      const answer = await recognizePartPhoto(bytes, {
        ...(cityId ? { cityId } : {}),
        ...vehicleQuery(car),
      });
      apply = () => {
        setAttempts(answer.attempts);
        const outcome = partPhotoOutcome(answer);
        if (outcome.kind === "not_found") {
          setPhase({ kind: "failed", failure: "no_article" });
          return;
        }
        setPhase({ kind: "camera" });
        onFound(outcome.found);
      };
    } catch (error) {
      apply = () => {
        const details = (error as { details?: { attempts?: VehicleDocumentAttempts } })?.details;
        if (details?.attempts) setAttempts(details.attempts);
        setPhase({ kind: "failed", failure: recognitionFailureOf(error) });
      };
    }
    if (token !== generation.current || !focused.current) {
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

  const failure = phase.kind === "failed" ? phase.failure : null;
  const guestLimit = failure === "limit" && attempts?.scope !== "account" && !remote;
  const failedText =
    failure === null
      ? null
      : failure === "no_article" || failure === "not_readable" || failure === "other_document"
        ? { title: t("partPhoto.notFoundTitle"), text: t("partPhoto.notFoundText"), retake: true }
        : failure === "limit"
          ? {
              title: t("doc.limitTitle"),
              text: t(guestLimit ? "partPhoto.limitText" : "partPhoto.limitTextSignedIn"),
              retake: false,
            }
          : failure === "offline"
            ? { title: t("garage.needsNetwork"), text: t("partPhoto.offlineText"), retake: true }
            : failure === "invalid"
              ? { title: t("doc.invalidTitle"), text: t("doc.invalidText"), retake: true }
              : {
                  title: t("doc.unavailableTitle"),
                  text: t("partPhoto.unavailableText"),
                  retake: false,
                };
  const attemptsNote =
    attempts?.scope === "guest" && failure !== "limit" ? (
      <Text variant="caption" color="textMuted" style={styles.center}>
        {t("doc.attemptsLeft", { count: attempts.remaining })}
      </Text>
    ) : null;

  return (
    <Screen
      title={t("partPhoto.title")}
      back={{ label: t("common.back"), onPress: onBack }}
      centerContent={phase.kind !== "camera"}
      footer={
        phase.kind === "camera" ? (
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
          </View>
        ) : failedText ? (
          <View style={styles.footer}>
            {attemptsNote}
            {failedText.retake && (
              <Button onPress={() => setPhase({ kind: "camera" })}>{t("doc.retake")}</Button>
            )}
            {guestLimit && <Button onPress={signIn.start}>{t("auth.signIn")}</Button>}
            <Button
              variant={failedText.retake || guestLimit ? "secondary" : "primary"}
              onPress={onTypeArticle}
            >
              {t("partPhoto.typeArticle")}
            </Button>
          </View>
        ) : null
      }
    >
      <ScreenBody>
        <View style={styles.stack}>
          {phase.kind === "camera" && (
            <>
              <CameraPanel
                camera={camera}
                cameraRef={cameraRef}
                hint={t("partPhoto.hint")}
                frame="label"
              />
              <Text variant="bodyS" color="textMuted">
                {t("partPhoto.privacy")}
              </Text>
            </>
          )}
          {phase.kind === "busy" && gate.indicator && (
            <View style={styles.busy} accessibilityLiveRegion="polite">
              <Icon name="sparkles" size={32} color="ai" />
              <Text color="textMuted">{t("doc.recognizing")}</Text>
            </View>
          )}
          {failedText && (
            <EmptyState
              icon={
                failure === "offline"
                  ? "wifiOff"
                  : failure === "no_article"
                    ? "search"
                    : "alertTriangle"
              }
              title={failedText.title}
              text={failedText.text}
            />
          )}
        </View>
      </ScreenBody>
    </Screen>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 12 },
  busy: { alignItems: "center", gap: 12, paddingVertical: 48 },
  footer: { gap: 8 },
  center: { textAlign: "center" },
});
