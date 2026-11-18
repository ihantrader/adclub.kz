import type { SpeechPurpose } from "@adclub/contracts";
import type { SpeechWatchState } from "@adclub/domain";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, Platform, StyleSheet, View } from "react-native";
import type { AssistantLimitSheet } from "../../assistant/assistant-rules";
import {
  Button,
  Icon,
  Sheet,
  Text,
  useAfterDismiss,
  useDelayedIndicator,
  useTheme,
} from "../../design-system";
import { transcribeSpeech, speechPort } from "../../services/speech";
import { useOnline } from "../../services/use-network";
import {
  voiceAnswerWanted,
  voiceFailureOf,
  voiceOnAppState,
  voiceOutcomeOf,
  voiceStartOf,
  type VoiceAccepted,
  type VoiceState,
} from "../../speech/voice-input";
import { sessionStore } from "../../state/stores";
import { useT } from "../../state/language";

export interface VoiceSheetProps {
  /** The sheet is open: the microphone was pressed. */
  visible: boolean;
  onClose: () => void;
  /**
   * The field the text goes into (TASK-060): the hint the model gets, the
   * length of the text, and the words of the sheet — its title, the example
   * phrase, the way back to typing.
   */
  purpose: SpeechPurpose;
  /**
   * What the field does with what was heard: what to do once the sheet has
   * gone (into the search line, the mileage field, the steps of a car), or
   * the state the sheet stays in — `not_understood` («Не поняли пробег»),
   * or the next request could not be made. The sheet shows «Распознаём…»
   * while it waits.
   */
  accept: (text: string) => VoiceAccepted | Promise<VoiceAccepted>;
  /** «Ввести текстом» (for a car — «Выбрать из списка»): the sheet closes, the field takes the focus. */
  onType: () => void;
  /** A limit spent (M-AI-02): the sheet closes, the screen opens the limit's sheet. */
  onLimit: (sheet: AssistantLimitSheet) => void;
  /** Every state that ended an attempt without a text the field took (a car: «Выбрать из списка» appears). */
  onFailure?: (failure: VoiceState | "limit") => void;
}

/** The words of the sheet for each field (TASK-060); the rest is one for all. */
function useVoiceTexts(purpose: SpeechPurpose) {
  const t = useT();
  switch (purpose) {
    case "mileage":
      return {
        explainTitle: t("voice.mileageTitle"),
        explainText: t("voice.mileageExplain"),
        example: t("voice.mileageExample"),
        typeText: t("voice.typeNumber"),
        notUnderstood: t("voice.mileageNotUnderstood"),
        notUnderstoodText: t("voice.mileageNotUnderstoodText"),
        retry: t("voice.retrySay"),
        unavailableText: t("voice.mileageUnavailableText"),
        deniedText: t("voice.deniedTextOther"),
      };
    case "vehicle":
      return {
        explainTitle: t("voice.vehicleTitle"),
        explainText: t("voice.vehicleExplain"),
        example: t("voice.vehicleExample"),
        typeText: t("doc.chooseFromList"),
        notUnderstood: t("voice.vehicleNotUnderstood"),
        notUnderstoodText: t("voice.vehicleNotUnderstoodText"),
        retry: t("voice.retrySay"),
        unavailableText: t("voice.vehicleUnavailableText"),
        deniedText: t("voice.deniedTextOther"),
      };
    case "assistant":
      return {
        explainTitle: t("voice.assistantTitle"),
        explainText: t("voice.assistantExplain"),
        example: t("voice.assistantExample"),
        typeText: t("voice.typeText"),
        notUnderstood: t("voice.notHeard"),
        notUnderstoodText: t("voice.notHeardText"),
        retry: t("voice.retry"),
        unavailableText: t("voice.assistantUnavailableText"),
        deniedText: t("voice.deniedText"),
      };
    case "search":
      return {
        explainTitle: t("voice.explainTitle"),
        explainText: t("voice.explainText"),
        example: t("voice.listeningHint"),
        typeText: t("voice.typeText"),
        notUnderstood: t("voice.notHeard"),
        notUnderstoodText: t("voice.notHeardText"),
        retry: t("voice.retry"),
        unavailableText: t("voice.unavailableText"),
        deniedText: t("voice.deniedText"),
      };
  }
}

const BARS = 7;

/**
 * Voice input, a sheet over the screen — one for every field a person may
 * speak into (TASK-060: M-CAT-05 the search, M-GAR-07 and M-REM-02 the
 * mileage, M-START-05 and M-GAR-02 a car, M-AI-01 a message):
 * the explanation before the system's question (SCREENS 2.8), «Говорите…»
 * with the level and «Стоп», «Распознаём…», and every state that is not a
 * text — «Не расслышали», «Голосовой ввод временно недоступен», «Нужна сеть».
 * The recording is held in memory only. Pressing the microphone twice,
 * closing the sheet or putting the app in the background throws the
 * recording away — nothing is sent.
 */
export function VoiceSheet({
  visible,
  onClose,
  purpose,
  accept,
  onType,
  onLimit,
  onFailure,
}: VoiceSheetProps) {
  const t = useT();
  const words = useVoiceTexts(purpose);
  const { theme, reduceMotion } = useTheme();
  const online = useOnline();
  const [state, setState] = useState<VoiceState | "starting">("starting");
  const [level, setLevel] = useState(0);
  const generation = useRef(0);
  // Read after every `await`: a closed sheet wants no answer (TASK-059.A).
  const open = useRef(visible);
  // The system's question about the microphone is on the screen.
  const asking = useRef(false);
  const dismissed = useAfterDismiss(visible);
  const wanted = (token: number) =>
    voiceAnswerWanted(token, { generation: generation.current, visible: open.current });

  useEffect(() => {
    open.current = visible;
  }, [visible]);
  // The place of the sheet went away with it open (the mileage question of
  // `HomeHintCard` answered, `CarMileageScreen` left without its car): the
  // recording is thrown away and no answer is wanted (TASK-060.A). A sheet
  // that was closed leaves the one recorder alone — another sheet may use it.
  useEffect(
    () => () => {
      generation.current += 1;
      if (open.current) speechPort.cancel();
      open.current = false;
    },
    [],
  );
  // The spinner of «Распознаём…» only after the delay of the loading rule (D-069).
  const spinner = useDelayedIndicator(state === "recognizing" || state === "starting");

  /** A state that ends the attempt without a text the field took. */
  const fail = (failure: VoiceState) => {
    setState(failure);
    onFailure?.(failure);
  };

  const close = (then?: () => void) => {
    generation.current += 1;
    speechPort.cancel();
    if (then) dismissed.after(then);
    onClose();
  };

  const record = async () => {
    generation.current += 1;
    const token = generation.current;
    setLevel(0);
    setState("listening");
    try {
      await speechPort.start({
        onUpdate: (watch: SpeechWatchState) => {
          if (token === generation.current) setLevel(watch.level);
        },
        onAutoStop: () => {
          if (wanted(token)) void send(token);
        },
      });
      // Closed while the microphone was opening: the port opened nothing,
      // and nothing of this recording may stay.
      if (!open.current) speechPort.cancel();
    } catch {
      if (wanted(token)) fail("unavailable");
    }
  };

  const send = async (token: number) => {
    const capture = await speechPort.finish();
    if (!wanted(token) || !capture) return;
    // Nothing that could be speech: «Не расслышали» at once, no attempt spent.
    if (!capture.heardAnything) {
      fail("not_heard");
      return;
    }
    if (!online) {
      fail("offline");
      return;
    }
    setState("recognizing");
    let said: string;
    try {
      const answer = await transcribeSpeech(capture.wav, purpose);
      if (!wanted(token)) return;
      const outcome = voiceOutcomeOf(answer);
      if (outcome.kind === "not_heard") {
        fail("not_heard");
        return;
      }
      said = outcome.text;
    } catch (error) {
      if (!wanted(token)) return;
      const failure = voiceFailureOf(error, sessionStore.get().status === "signed_in");
      if (typeof failure === "object") {
        const sheet = failure.limit;
        onFailure?.("limit");
        close(() => onLimit(sheet));
        return;
      }
      fail(failure);
      return;
    }
    // The field's own step (a car placed in the catalog) — still «Распознаём…».
    let accepted: VoiceAccepted;
    try {
      accepted = await accept(said);
    } catch {
      accepted = "unavailable";
    }
    if (!wanted(token)) return;
    if (typeof accepted === "function") close(accepted);
    else fail(accepted);
  };

  const begin = async () => {
    generation.current += 1;
    const token = generation.current;
    setState("starting");
    if (!online) {
      fail("offline");
      return;
    }
    if (!speechPort.available) {
      fail("unavailable");
      return;
    }
    const permission = await speechPort.permission().catch(() => null);
    if (!wanted(token)) return;
    if (!permission) {
      fail("unavailable");
      return;
    }
    const first = voiceStartOf(permission);
    if (first === "record") void record();
    else if (first === "denied") fail(first);
    else setState(first);
  };

  const allow = async () => {
    generation.current += 1;
    const token = generation.current;
    asking.current = true;
    const answer = await speechPort.request().catch(() => null);
    asking.current = false;
    // The sheet closed while the system asked: the microphone is not opened.
    if (!wanted(token)) return;
    if (answer?.status === "granted") void record();
    else fail("denied");
  };

  useEffect(() => {
    if (!visible) {
      generation.current += 1;
      speechPort.cancel();
      return;
    }
    // Started after the render that opened the sheet, not inside the effect.
    const timer = setTimeout(() => void begin(), 0);
    return () => clearTimeout(timer);
    // `begin` reads the current network state each time the sheet opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // The app put away with the sheet open: the recording is thrown away. The
  // system's question about the microphone takes the app out of `active`
  // itself, and is not the person leaving (TASK-059.A).
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      const moment = !visible ? "closed" : asking.current ? "asking" : "open";
      if (voiceOnAppState(moment, next) === "discard") {
        generation.current += 1;
        speechPort.cancel();
        onClose();
      }
    });
    return () => subscription.remove();
  }, [visible, onClose]);

  const title =
    state === "explain"
      ? words.explainTitle
      : state === "denied"
        ? t("voice.deniedTitle")
        : state === "listening"
          ? t("voice.listening")
          : state === "recognizing" || state === "starting"
            ? t("voice.recognizing")
            : state === "not_heard"
              ? t("voice.notHeard")
              : state === "not_understood"
                ? words.notUnderstood
                : state === "offline"
                  ? t("voice.offlineTitle")
                  : state === "too_long"
                    ? t("voice.tooLong")
                    : t("voice.unavailable");

  return (
    <Sheet
      visible={visible}
      onClose={() => close()}
      onDismissed={dismissed.onDismissed}
      title={state === "starting" ? " " : title}
      closeLabel={t("common.close")}
    >
      <View style={styles.body} accessibilityLiveRegion="polite">
        {state === "explain" && (
          <>
            <View style={styles.center}>
              <Icon name="microphone" size={40} color="accent" />
            </View>
            <Text color="textMuted">{words.explainText}</Text>
            <Button onPress={() => void allow()}>{t("voice.explainContinue")}</Button>
            {/* «Не сейчас» of a car closes the sheet only: the list is for a failure, not a choice. */}
            <Button
              variant="secondary"
              onPress={() => close(purpose === "vehicle" ? undefined : onType)}
            >
              {t("voice.notNow")}
            </Button>
          </>
        )}
        {state === "denied" && (
          <>
            <Text color="textMuted">{words.deniedText}</Text>
            {/* A browser has no settings page to open. */}
            {Platform.OS !== "web" && (
              <Button onPress={() => void speechPort.openSettings()}>
                {t("voice.openSettings")}
              </Button>
            )}
            <Button variant="secondary" onPress={() => close(onType)}>
              {words.typeText}
            </Button>
          </>
        )}
        {state === "listening" && (
          <>
            <View
              style={styles.bars}
              accessible
              accessibilityRole="progressbar"
              accessibilityLabel={t("voice.level")}
              accessibilityValue={{ min: 0, max: 100, now: Math.round(level * 100) }}
              testID="voice-level"
            >
              {Array.from({ length: BARS }, (_, index) => {
                // The middle bars rise first: the shape of a voice, not a meter.
                const weight = 1 - Math.abs(index - (BARS - 1) / 2) / BARS;
                const height = 8 + Math.round(48 * Math.min(1, level * (0.6 + weight)));
                return (
                  <View
                    key={index}
                    style={[
                      styles.bar,
                      {
                        height: reduceMotion ? 8 + Math.round(48 * level) : height,
                        backgroundColor: theme.colors.accent,
                      },
                    ]}
                  />
                );
              })}
            </View>
            <Text color="textMuted" style={styles.centerText}>
              {words.example}
            </Text>
            <Button icon="microphone" onPress={() => void send(generation.current)}>
              {t("voice.stop")}
            </Button>
            <Button variant="secondary" onPress={() => close()}>
              {t("common.cancel")}
            </Button>
          </>
        )}
        {(state === "recognizing" || state === "starting") && (
          <View style={styles.busy}>
            {spinner ? <ActivityIndicator color={theme.colors.ai} /> : null}
          </View>
        )}
        {(state === "not_heard" || state === "too_long" || state === "not_understood") && (
          <>
            <Text color="textMuted">
              {state === "not_heard"
                ? t("voice.notHeardText")
                : state === "not_understood"
                  ? words.notUnderstoodText
                  : t("voice.tooLongText")}
            </Text>
            <Button icon="microphone" onPress={() => void record()}>
              {words.retry}
            </Button>
            <Button variant="secondary" onPress={() => close(onType)}>
              {words.typeText}
            </Button>
          </>
        )}
        {state === "unavailable" && (
          <>
            <Text color="textMuted">{words.unavailableText}</Text>
            <Button onPress={() => close(onType)}>{words.typeText}</Button>
          </>
        )}
        {state === "offline" && (
          <>
            <Text color="textMuted">{t("voice.offlineText")}</Text>
            <Button onPress={() => close(onType)}>{words.typeText}</Button>
          </>
        )}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { gap: 12, paddingBottom: 8 },
  center: { alignItems: "center", paddingVertical: 8 },
  centerText: { textAlign: "center" },
  busy: { alignItems: "center", paddingVertical: 32 },
  bars: {
    height: 64,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  bar: { width: 6, borderRadius: 3 },
});
