import type { SpeechTranscription } from "@adclub/contracts";
import type { AssistantLimitSheet } from "../assistant/assistant-rules";
import { guestAiClosed } from "../assistant/guest-ai-closed";
import type { MicrophonePermission } from "./speech-port";

/**
 * Voice input (TASK-059; SCREENS M-CAT-05, M-AI-02, 2.8) as rules the sheet
 * only draws — one sheet for every field a person may speak into (TASK-060:
 * the search line, the mileage, a car to add, a message to the assistant).
 *
 * The states of the sheet over the screen:
 * - `explain` — before the system's question: why the microphone;
 * - `denied` — the system will not ask again: «Разрешите доступ к
 *   микрофону в настройках», and the search line;
 * - `listening` — «Говорите…», the level, «Стоп»;
 * - `recognizing` — «Распознаём…»;
 * - `not_heard` — «Не расслышали, попробуйте ещё раз»;
 * - `not_understood` — heard, but the field could not use it («Не поняли
 *   пробег», «Не поняли автомобиль», TASK-060);
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
  | "not_understood"
  | "unavailable"
  | "offline"
  | "too_long";

/** What pressing the microphone does first, by the permission the system has. */
export function voiceStartOf(permission: MicrophonePermission): "record" | "explain" | "denied" {
  if (permission.status === "granted") return "record";
  if (permission.status === "denied" && !permission.canAskAgain) return "denied";
  return "explain";
}

/**
 * What a transcription gives the field: the text, or «Не расслышали». The
 * server says whether anything was heard — one letter or digit is not
 * (`cleanSpeechText`, TASK-060); the app keeps no rule of its own.
 */
export function voiceOutcomeOf(
  answer: SpeechTranscription,
): { kind: "text"; text: string } | { kind: "not_heard" } {
  // A message to the assistant comes whole in `message`; a line in `text`.
  const text = (answer.message ?? answer.text).trim();
  return answer.heard && text !== "" ? { kind: "text", text } : { kind: "not_heard" };
}

/**
 * What a field did with the text it was given (TASK-060): what to do once
 * the sheet has gone (put it into the line, the field, the steps of a car),
 * or the state the sheet stays in — the text said nothing the field could
 * use, or the next request could not be made.
 */
export type VoiceAccepted = (() => void) | "not_understood" | "offline" | "unavailable";

/**
 * Whether a failure of voice opens «Выбрать из списка» when a car is being
 * added (TASK-060; SCREENS M-START-05, M-GAR-02): as a photo that did not
 * work — not heard, not understood, no microphone, unavailable, the limit,
 * no network. Only the states that end the attempt count: the explanation
 * before the system's question and the recording itself do not.
 */
export function voiceFailureOpensList(failure: VoiceState | "limit"): boolean {
  return failure !== "explain" && failure !== "listening" && failure !== "recognizing";
}

export type VoiceFailure = VoiceState | { limit: AssistantLimitSheet };

/** The state of a refused request, from the error the API client threw. */
export function voiceFailureOf(error: unknown, signedIn: boolean): VoiceFailure {
  const value = error as { code?: unknown; details?: unknown } | null;
  const code = typeof value?.code === "string" ? value.code : "";
  const details = (value?.details ?? {}) as { limit?: unknown; reason?: unknown };
  if (code === "NETWORK_ERROR") return "offline";
  // AI for signed-in people only now (TASK-066): M-AI-02 of the guests' budget.
  if (guestAiClosed(error)) return { limit: "guest_budget" };
  if (code === "RATE_LIMITED") {
    if (details.limit === "speech_per_account") return { limit: "day" };
    if (details.limit === "speech_per_device") return { limit: "guest_trial" };
    // The flood limit of an address (TASK-059.A): not the person's limit — try later.
    if (details.limit === "speech_requests_per_ip") return "unavailable";
    // The address: many guests of one network; to the person it is the trial limit.
    return signedIn ? { limit: "day" } : { limit: "guest_trial" };
  }
  if (code === "SPEECH_UNAVAILABLE" && details.reason === "budget" && !signedIn) {
    return { limit: "guest_budget" };
  }
  if (code === "PAYLOAD_TOO_LARGE" && details.reason === "duration") return "too_long";
  return "unavailable";
}

/**
 * Where the sheet is when the app's state changes (TASK-059.A):
 * - `closed` — the sheet is not open;
 * - `asking` — the system's question about the microphone is on the screen:
 *   it takes the app out of `active` itself (iOS — `inactive`, Android —
 *   `background`, the permission activity pauses the app's one);
 * - `open` — any other moment of the open sheet, recording included.
 */
export type VoiceSheetMoment = "closed" | "asking" | "open";

/**
 * What the sheet does when the app leaves or returns to `active`: an app put
 * away with the sheet open throws the recording away and closes the sheet
 * (nothing is sent); the system's own question is not the person leaving.
 */
export function voiceOnAppState(moment: VoiceSheetMoment, next: string): "keep" | "discard" {
  if (moment !== "open") return "keep";
  return next === "active" ? "keep" : "discard";
}

/**
 * Whether the answer of something awaited is still wanted: the sheet is still
 * open and nothing newer was started (a closed sheet, a second press, a retry
 * each start a new generation). Checked after every `await` of the sheet —
 * otherwise a permission granted after the sheet closed would start the
 * microphone with no sheet on the screen.
 */
export function voiceAnswerWanted(
  started: number,
  now: { generation: number; visible: boolean },
): boolean {
  return now.visible && started === now.generation;
}

/** The «распознано» mark stays while the line holds what was heard. */
export function stillRecognizedText(line: string, heard: string): boolean {
  return line.trim() === heard.trim();
}
