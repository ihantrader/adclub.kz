import { SPEECH_SAMPLE_RATE, toSpeechPcm } from "@adclub/domain";
import { createRecordingBuffer, type MicrophonePermission, type SpeechPort } from "./speech-port";

/** One chunk of the PCM stream of `expo-audio`. */
export interface NativeAudioChunk {
  data: ArrayBuffer;
  sampleRate: number;
  channels: number;
}

/** What the port needs of a stream: the part of `expo-audio`'s `AudioStream` it uses. */
export interface NativeAudioStream {
  addListener(
    event: "audioStreamBuffer",
    listener: (chunk: NativeAudioChunk) => void,
  ): { remove(): void };
  start(): Promise<void>;
  stop(): void;
  release(): void;
}

/** The platform under the port (`expo-audio`, `Linking`) — substituted in a test. */
export interface NativeSpeechDeps {
  permission(): Promise<MicrophonePermission>;
  request(): Promise<MicrophonePermission>;
  setRecordingMode(recording: boolean): Promise<void>;
  createStream(options: { sampleRate: number; channels: 1; encoding: "int16" }): NativeAudioStream;
  openSettings(): Promise<void>;
}

/**
 * The microphone of a phone (TASK-059; TASK-059.A): the PCM stream held in
 * memory, never written to a file.
 *
 * `start` awaits the audio mode and the stream. A `cancel` (or `finish`, or a
 * newer `start`) that comes while it waits ends this attempt: after every
 * `await` the attempt is checked, and an ended one closes whatever it had
 * opened — the stream, its listener, the recording mode — and calls no
 * handler. Otherwise the microphone stayed on with no sheet on the screen.
 */
export function createNativeSpeechPortWith(deps: NativeSpeechDeps): SpeechPort {
  let attempt = 0;
  let stream: NativeAudioStream | null = null;
  let listener: { remove(): void } | null = null;
  let buffer: ReturnType<typeof createRecordingBuffer> | null = null;

  const close = (own: NativeAudioStream | null, ownListener: { remove(): void } | null) => {
    try {
      ownListener?.remove();
    } catch {
      // Already removed.
    }
    try {
      own?.stop();
    } catch {
      // A stream that is not running is what was wanted.
    }
    try {
      own?.release();
    } catch {
      // Already released.
    }
  };

  const release = () => {
    close(stream, listener);
    stream = null;
    listener = null;
    void deps.setRecordingMode(false).catch(() => undefined);
  };

  /** Ends whatever attempt is running or starting. */
  const end = () => {
    attempt += 1;
    buffer?.drop();
    buffer = null;
    release();
  };

  return {
    available: true,
    permission: () => deps.permission(),
    request: () => deps.request(),
    async start(handlers) {
      end();
      const mine = attempt;
      const live = () => mine === attempt;
      await deps.setRecordingMode(true);
      if (!live()) {
        // Ended while the mode was set: nothing was opened but the mode.
        void deps.setRecordingMode(false).catch(() => undefined);
        return;
      }
      const recording = createRecordingBuffer(handlers);
      const own = deps.createStream({
        sampleRate: SPEECH_SAMPLE_RATE,
        channels: 1,
        encoding: "int16",
      });
      const ownListener = own.addListener("audioStreamBuffer", (chunk) => {
        // Chunks of an ended attempt reach no handler.
        if (live()) recording.push(toSpeechPcm(chunk.data, chunk.sampleRate, chunk.channels));
      });
      stream = own;
      listener = ownListener;
      buffer = recording;
      try {
        await own.start();
      } catch (error) {
        close(own, ownListener);
        if (!live()) return;
        buffer = null;
        stream = null;
        listener = null;
        void deps.setRecordingMode(false).catch(() => undefined);
        throw error;
      }
      if (!live()) {
        // `cancel` released the stream before it had started: it is closed
        // again now that `start` has opened it.
        recording.drop();
        close(own, ownListener);
        void deps.setRecordingMode(false).catch(() => undefined);
      }
    },
    finish() {
      const recording = buffer;
      buffer = null;
      attempt += 1;
      release();
      return Promise.resolve(recording ? recording.capture() : null);
    },
    cancel: end,
    openSettings: () => deps.openSettings(),
  };
}
