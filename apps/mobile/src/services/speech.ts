import type { SpeechTranscription } from "@adclub/contracts";
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
 */
export async function transcribeSpeech(wav: Uint8Array): Promise<SpeechTranscription> {
  const query = sessionStore.get().status === "signed_in" ? {} : { deviceId: await deviceId() };
  return apiClient.transcribeSpeech(wav, { query, contentType: "audio/wav" });
}
