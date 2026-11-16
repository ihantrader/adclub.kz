import {
  createSpeechWatch,
  encodeWav,
  speechHeardAnything,
  SPEECH_SAMPLE_RATE,
  type SpeechWatchState,
} from "@adclub/domain";

/**
 * The microphone of voice input (TASK-059; SCREENS M-CAT-05; ARCHITECTURE
 * 4.90). Whatever the platform gives — the PCM stream of `expo-audio` on a
 * phone, Web Audio in a browser, a sample file in the browser of development
 * — the app turns into one thing: mono 16-bit PCM at 16 kHz, a WAV. The level
 * of the indicator and when the recording stops by itself (silence after
 * speech, the length limit) are computed from those samples
 * (`createSpeechWatch`), so the rule is the same everywhere. Nothing is
 * written to a file: the samples are held in memory until the request is
 * sent, and dropped.
 */

/** The length limit the app records to: `speech_max_seconds` (15) of the server's default. */
export const SPEECH_MAX_SECONDS = 15;

export type MicrophoneStatus = "granted" | "undetermined" | "denied";

export interface MicrophonePermission {
  status: MicrophoneStatus;
  /** `false` — the system will not ask again: only its settings can allow it. */
  canAskAgain: boolean;
}

export interface SpeechCapture {
  wav: Uint8Array;
  seconds: number;
  /** Something that could be speech was heard: a recording without it is not sent. */
  heardAnything: boolean;
}

export interface RecordingHandlers {
  /** The level, about ten times a second. */
  onUpdate: (state: SpeechWatchState) => void;
  /** The recording stopped by itself (silence after speech, the limit): call `finish`. */
  onAutoStop: () => void;
}

export interface SpeechPort {
  /** `false` — this build has no microphone at all. */
  readonly available: boolean;
  permission(): Promise<MicrophonePermission>;
  /** The system's dialog — only after the app has said why (SCREENS 2.8). */
  request(): Promise<MicrophonePermission>;
  /** Starts recording; throws when the microphone can't be opened. */
  start(handlers: RecordingHandlers): Promise<void>;
  /** Stops and gives the recording; `null` — nothing was recording. */
  finish(): Promise<SpeechCapture | null>;
  /** Stops and throws the recording away. */
  cancel(): void;
  openSettings(): Promise<void>;
}

/**
 * The samples of one recording as they come: the level watch, the limit,
 * and the WAV at the end. One per recording; every port uses it.
 */
export function createRecordingBuffer(handlers: RecordingHandlers) {
  const watch = createSpeechWatch({
    sampleRate: SPEECH_SAMPLE_RATE,
    maxSeconds: SPEECH_MAX_SECONDS,
  });
  const chunks: Int16Array[] = [];
  let length = 0;
  let stopped = false;
  let lastUpdate = 0;
  return {
    push(samples: Int16Array): void {
      if (stopped || samples.length === 0) return;
      chunks.push(samples);
      length += samples.length;
      const state = watch.push(samples);
      const now = Date.now();
      if (now - lastUpdate >= 90 || state.stop) {
        lastUpdate = now;
        handlers.onUpdate(state);
      }
      if (state.stop) {
        stopped = true;
        handlers.onAutoStop();
      }
    },
    capture(): SpeechCapture {
      stopped = true;
      const all = new Int16Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        all.set(chunk, offset);
        offset += chunk.length;
      }
      chunks.length = 0;
      // Not longer than the limit, whatever arrived after it.
      const kept = all.subarray(0, SPEECH_MAX_SECONDS * SPEECH_SAMPLE_RATE);
      return {
        wav: encodeWav(kept, SPEECH_SAMPLE_RATE),
        seconds: kept.length / SPEECH_SAMPLE_RATE,
        heardAnything: speechHeardAnything(kept, SPEECH_SAMPLE_RATE),
      };
    },
    drop(): void {
      stopped = true;
      chunks.length = 0;
    },
  };
}

/** A port without a microphone. */
export const NO_MICROPHONE: SpeechPort = {
  available: false,
  permission: () => Promise.resolve({ status: "denied", canAskAgain: false }),
  request: () => Promise.resolve({ status: "denied", canAskAgain: false }),
  start: () => Promise.reject(new Error("No microphone in this build")),
  finish: () => Promise.resolve(null),
  cancel: () => undefined,
  openSettings: () => Promise.resolve(),
};
