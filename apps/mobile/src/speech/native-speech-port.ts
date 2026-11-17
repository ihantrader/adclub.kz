import {
  AudioModule,
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from "expo-audio";
import { Linking } from "react-native";
import { createNativeSpeechPortWith, type NativeAudioStream } from "./native-speech-core";
import type { MicrophonePermission, SpeechPort } from "./speech-port";

function permissionOf(answer: {
  granted: boolean;
  canAskAgain: boolean;
  status: string;
}): MicrophonePermission {
  return {
    status: answer.granted
      ? "granted"
      : answer.status === "undetermined"
        ? "undetermined"
        : "denied",
    canAskAgain: answer.canAskAgain,
  };
}

/**
 * The microphone of a phone (TASK-059): the PCM stream of `expo-audio`
 * (`AudioStream`, 16-bit, mono, 16 kHz asked — the device may give another
 * rate, which is resampled), held in memory, never written to a file. The
 * logic — and what a cancel during the start closes — is
 * `createNativeSpeechPortWith` (`native-speech-core.ts`, TASK-059.A).
 */
export function createNativeSpeechPort(): SpeechPort {
  return createNativeSpeechPortWith({
    permission: async () => permissionOf(await getRecordingPermissionsAsync()),
    request: async () => permissionOf(await requestRecordingPermissionsAsync()),
    setRecordingMode: (recording) =>
      recording
        ? setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true })
        : setAudioModeAsync({ allowsRecording: false }),
    createStream: (options) => new AudioModule.AudioStream(options) as NativeAudioStream,
    openSettings: () => Linking.openSettings(),
  });
}
