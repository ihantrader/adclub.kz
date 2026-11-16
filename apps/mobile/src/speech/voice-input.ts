import type { SpeechTranscription } from "@adclub/contracts";
import type { AssistantLimitSheet } from "../assistant/assistant-rules";
import type { MicrophonePermission } from "./speech-port";

/**
 * Voice input in the search (TASK-059; SCREENS M-CAT-05, M-AI-02, 2.8) as
 * rules the screen only draws.
 *
 * The states of the sheet over the screen:
 * - `explain` — before the system's question: why the microphone;
 * - `denied` — the system will not ask again: «Разрешите доступ к
 *   микрофону в настройках», and the search line;
 * - `listening` — «Говорите…», the level, «Стоп»;
 * - `recognizing` — «Распознаём…»;
 * - `not_heard` — «Не расслышали, попробуйте ещё раз»;
 * - `unavailable` — «Голосовой ввод временно недоступен», the search line;
 * - `offline` — «Нужна сеть»;
 * - `too_long` — the server's limit was shorter than the app's.
 * A guest's limit or the guests' budget, and a person's limit of the day,
 * close the sheet and open M-AI-02.
 */
export type VoiceState =
  | "explain"
  | "denied"
  | "listening"
  | "recognizing"
  | "not_heard"
  | "unavailable"
  | "offline"
  | "too_long";

/** What pressing the microphone does first, by the permission the system has. */
export function voiceStartOf(permission: MicrophonePermission): "record" | "explain" | "denied" {
  if (permission.status === "granted") return "record";
  if (permission.status === "denied" && !permission.canAskAgain) return "denied";
  return "explain";
}

/** What a transcription gives the search: the text, or «Не расслышали». */
export function voiceOutcomeOf(
  answer: SpeechTranscription,
): { kind: "text"; text: string } | { kind: "not_heard" } {
  const text = answer.text.trim();
  // One letter is not a query the search takes (at least two signs).
  return answer.heard && text.length >= 2 ? { kind: "text", text } : { kind: "not_heard" };
}

export type VoiceFailure = VoiceState | { limit: AssistantLimitSheet };

/** The state of a refused request, from the error the API client threw. */
export function voiceFailureOf(error: unknown, signedIn: boolean): VoiceFailure {
  const value = error as { code?: unknown; details?: unknown } | null;
  const code = typeof value?.code === "string" ? value.code : "";
  const details = (value?.details ?? {}) as { limit?: unknown; reason?: unknown };
  if (code === "NETWORK_ERROR") return "offline";
  if (code === "RATE_LIMITED") {
    if (details.limit === "speech_per_account") return { limit: "day" };
    if (details.limit === "speech_per_device") return { limit: "guest_trial" };
    // The address: many guests of one network; to the person it is the trial limit.
    return signedIn ? { limit: "day" } : { limit: "guest_trial" };
  }
  if (code === "SPEECH_UNAVAILABLE" && details.reason === "budget" && !signedIn) {
    return { limit: "guest_budget" };
  }
  if (code === "PAYLOAD_TOO_LARGE" && details.reason === "duration") return "too_long";
  return "unavailable";
}

/** The «распознано» mark stays while the line holds what was heard. */
export function stillRecognizedText(line: string, heard: string): boolean {
  return line.trim() === heard.trim();
}
