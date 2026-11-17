import type { SpeechPurpose, SpeechTranscription, VehicleMatchResponse } from "@adclub/contracts";
import { Platform } from "react-native";
import { createNativeSpeechPort } from "../speech/native-speech-port";
import type { SpeechPort } from "../speech/speech-port";
import { createWebSpeechPort } from "../speech/web-speech-port";
import { sessionStore } from "../state/stores";
import { apiClient } from "./api";
import { deviceId } from "./vehicle-document";

/**
 * Voice input of this build (TASK-059): `expo-audio` on a phone, Web Audio
 * in a browser — where a check of development substitutes a sample file
 * through `globalThis.__adclubSpeech` (the embedded browser has no microphone).
 */
export const speechPort: SpeechPort =
  Platform.OS === "web" ? createWebSpeechPort() : createNativeSpeechPort();

/**
 * What was said: the recording goes in one request and is held nowhere
 * after it; a guest's trial voice requests are counted by this device.
 * `purpose` — the field it is said into (TASK-060): the hint the model gets
 * and how long the text may be.
 */
export async function transcribeSpeech(
  wav: Uint8Array,
  purpose: SpeechPurpose,
): Promise<SpeechTranscription> {
  const query =
    sessionStore.get().status === "signed_in"
      ? { purpose }
      : { deviceId: await deviceId(), purpose };
  return apiClient.transcribeSpeech(wav, { query, contentType: "audio/wav" });
}

/**
 * A car named by voice placed in the vehicle catalog by the server (TASK-060,
 * `POST /vehicles/match`): no AI, no attempt spent; the answer has the form
 * of a certificate's, so it goes into the steps the same way.
 */
export function matchVehicleText(text: string): Promise<VehicleMatchResponse> {
  return apiClient.matchVehicleText({ text });
}
