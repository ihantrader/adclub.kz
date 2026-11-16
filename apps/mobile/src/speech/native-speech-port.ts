import { toSpeechPcm, SPEECH_SAMPLE_RATE } from "@adclub/domain";
import {
  AudioModule,
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  type AudioStreamBuffer,
} from "expo-audio";
import { Linking } from "react-native";
import { createRecordingBuffer, type MicrophonePermission, type SpeechPort } from "./speech-port";

type Stream = InstanceType<typeof AudioModule.AudioStream>;

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
 * rate, which is resampled), held in memory, never written to a file.
 */
export function createNativeSpeechPort(): SpeechPort {
  let stream: Stream | null = null;
  let buffer: ReturnType<typeof createRecordingBuffer> | null = null;
  let listener: { remove(): void } | null = null;

  const release = () => {
    listener?.remove();
    listener = null;
    try {
      stream?.stop();
      stream?.release();
    } catch {
      // A stream that is already gone is what was wanted.
    }
    stream = null;
    void setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
  };

  return {
    available: true,
    permission: async () => permissionOf(await getRecordingPermissionsAsync()),
    request: async () => permissionOf(await requestRecordingPermissionsAsync()),
    async start(handlers) {
      release();
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      buffer = createRecordingBuffer(handlers);
      const recording = buffer;
      stream = new AudioModule.AudioStream({
        sampleRate: SPEECH_SAMPLE_RATE,
        channels: 1,
        encoding: "int16",
      });
      listener = stream.addListener("audioStreamBuffer", (chunk: AudioStreamBuffer) => {
        recording.push(toSpeechPcm(chunk.data, chunk.sampleRate, chunk.channels));
      });
      try {
        await stream.start();
      } catch (error) {
        buffer = null;
        release();
        throw error;
      }
    },
    finish() {
      const recording = buffer;
      buffer = null;
      release();
      return Promise.resolve(recording ? recording.capture() : null);
    },
    cancel() {
      buffer?.drop();
      buffer = null;
      release();
    },
    openSettings: () => Linking.openSettings(),
  };
}
