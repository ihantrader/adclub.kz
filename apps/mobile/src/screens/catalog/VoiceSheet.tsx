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
  type VoiceState,
} from "../../speech/voice-input";
import { sessionStore } from "../../state/stores";
import { useT } from "../../state/language";

export interface VoiceSheetProps {
  /** The sheet is open: the microphone was pressed. */
  visible: boolean;
  onClose: () => void;
  /** What was heard: into the search line, searched at once. */
  onText: (text: string) => void;
  /** «Ввести текстом» and the states that end in the line: the sheet closes, the line takes the focus. */
  onType: () => void;
  /** A limit spent (M-AI-02): the sheet closes, the screen opens the limit's sheet. */
  onLimit: (sheet: AssistantLimitSheet) => void;
}

const BARS = 7;

/**
 * M-CAT-05 — voice input of the search (TASK-059), a sheet over the screen:
 * the explanation before the system's question (SCREENS 2.8), «Говорите…»
 * with the level and «Стоп», «Распознаём…», and every state that is not a
 * text — «Не расслышали», «Голосовой ввод временно недоступен», «Нужна сеть».
 * The recording is held in memory only. Pressing the microphone twice,
 * closing the sheet or putting the app in the background throws the
 * recording away — nothing is sent.
 */
export function VoiceSheet({ visible, onClose, onText, onType, onLimit }: VoiceSheetProps) {
  const t = useT();
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
  // The spinner of «Распознаём…» only after the delay of the loading rule (D-069).
  const spinner = useDelayedIndicator(state === "recognizing" || state === "starting");

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
      if (wanted(token)) setState("unavailable");
    }
  };

  const send = async (token: number) => {
    const capture = await speechPort.finish();
    if (!wanted(token) || !capture) return;
    // Nothing that could be speech: «Не расслышали» at once, no attempt spent.
    if (!capture.heardAnything) {
      setState("not_heard");
      return;
    }
    if (!online) {
      setState("offline");
      return;
    }
    setState("recognizing");
    try {
      const answer = await transcribeSpeech(capture.wav);
      if (!wanted(token)) return;
      const outcome = voiceOutcomeOf(answer);
      if (outcome.kind === "not_heard") {
        setState("not_heard");
        return;
      }
      close(() => onText(outcome.text));
    } catch (error) {
      if (!wanted(token)) return;
      const failure = voiceFailureOf(error, sessionStore.get().status === "signed_in");
      if (typeof failure === "object") {
        const sheet = failure.limit;
        close(() => onLimit(sheet));
        return;
      }
      setState(failure);
    }
  };

  const begin = async () => {
    generation.current += 1;
    const token = generation.current;
    setState("starting");
    if (!online) {
      setState("offline");
      return;
    }
    if (!speechPort.available) {
      setState("unavailable");
      return;
    }
    const permission = await speechPort.permission().catch(() => null);
    if (!wanted(token)) return;
    if (!permission) {
      setState("unavailable");
      return;
    }
    const first = voiceStartOf(permission);
    if (first === "record") void record();
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
    else setState("denied");
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
      ? t("voice.explainTitle")
      : state === "denied"
        ? t("voice.deniedTitle")
        : state === "listening"
          ? t("voice.listening")
          : state === "recognizing" || state === "starting"
            ? t("voice.recognizing")
            : state === "not_heard"
              ? t("voice.notHeard")
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
            <Text color="textMuted">{t("voice.explainText")}</Text>
            <Button onPress={() => void allow()}>{t("voice.explainContinue")}</Button>
            <Button variant="secondary" onPress={() => close(onType)}>
              {t("voice.notNow")}
            </Button>
          </>
        )}
        {state === "denied" && (
          <>
            <Text color="textMuted">{t("voice.deniedText")}</Text>
            {/* A browser has no settings page to open. */}
            {Platform.OS !== "web" && (
              <Button onPress={() => void speechPort.openSettings()}>
                {t("voice.openSettings")}
              </Button>
            )}
            <Button variant="secondary" onPress={() => close(onType)}>
              {t("voice.typeText")}
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
              {t("voice.listeningHint")}
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
        {(state === "not_heard" || state === "too_long") && (
          <>
            <Text color="textMuted">
              {state === "not_heard" ? t("voice.notHeardText") : t("voice.tooLongText")}
            </Text>
            <Button icon="microphone" onPress={() => void record()}>
              {t("voice.retry")}
            </Button>
            <Button variant="secondary" onPress={() => close(onType)}>
              {t("voice.typeText")}
            </Button>
          </>
        )}
        {state === "unavailable" && (
          <>
            <Text color="textMuted">{t("voice.unavailableText")}</Text>
            <Button onPress={() => close(onType)}>{t("voice.typeText")}</Button>
          </>
        )}
        {state === "offline" && (
          <>
            <Text color="textMuted">{t("voice.offlineText")}</Text>
            <Button onPress={() => close(onType)}>{t("voice.typeText")}</Button>
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
