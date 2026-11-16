import {
  floatToPcm16,
  readWav,
  resamplePcm16,
  speechHeardAnything,
  SPEECH_SAMPLE_RATE,
  wavSamples,
} from "@adclub/domain";
import {
  createRecordingBuffer,
  type MicrophonePermission,
  type SpeechCapture,
  type SpeechPort,
} from "./speech-port";

/**
 * The substitution of the microphone in the browser of development
 * (`globalThis.__adclubSpeech`, TASK-059): the embedded browser pane has no
 * microphone, so a check sets a sample file to be «said» — it is played into
 * the level watch in real time (the indicator moves, silence after speech
 * stops it) and sent as it is, so the test AI provider knows it by its code.
 * `permission` — what the «system» answers.
 */
export interface SpeechSubstitution {
  /** The URL of a WAV sample, e.g. served from `ai-eval/speech/samples`. */
  file?: string;
  /** What the system answers; left out — `granted`. */
  permission?: "granted" | "denied" | "undetermined";
  /** How fast the file is played, 1 — real time. */
  speed?: number;
}

function substitution(): SpeechSubstitution | null {
  if (!__DEV__) return null;
  const value = (globalThis as { __adclubSpeech?: SpeechSubstitution }).__adclubSpeech;
  return value ?? null;
}

function substitutedPermission(sub: SpeechSubstitution): MicrophonePermission {
  const status = sub.permission ?? "granted";
  return { status, canAskAgain: status !== "denied" };
}

/**
 * The microphone of a browser (TASK-059): Web Audio — `getUserMedia`, the
 * samples of a `ScriptProcessorNode` turned into 16 kHz 16-bit PCM in memory.
 */
export function createWebSpeechPort(): SpeechPort {
  let stop: (() => void) | null = null;
  let buffer: ReturnType<typeof createRecordingBuffer> | null = null;
  let substituted: { wav: Uint8Array } | null = null;

  const media = () =>
    (globalThis as { navigator?: { mediaDevices?: MediaDevices } }).navigator?.mediaDevices;

  async function browserPermission(): Promise<MicrophonePermission> {
    try {
      const answer = await navigator.permissions.query({ name: "microphone" as PermissionName });
      if (answer.state === "granted") return { status: "granted", canAskAgain: true };
      if (answer.state === "denied") return { status: "denied", canAskAgain: false };
    } catch {
      // A browser that can't say: it asks when the microphone is opened.
    }
    return { status: "undetermined", canAskAgain: true };
  }

  return {
    get available() {
      return substitution()?.file !== undefined || media()?.getUserMedia !== undefined;
    },
    permission() {
      const sub = substitution();
      return sub ? Promise.resolve(substitutedPermission(sub)) : browserPermission();
    },
    async request() {
      const sub = substitution();
      if (sub) {
        if ((sub.permission ?? "granted") === "undetermined") sub.permission = "granted";
        return substitutedPermission(sub);
      }
      try {
        const stream = await media()!.getUserMedia({ audio: true });
        for (const track of stream.getTracks()) track.stop();
        return { status: "granted", canAskAgain: true };
      } catch {
        return { status: "denied", canAskAgain: false };
      }
    },
    async start(handlers) {
      stop?.();
      buffer = createRecordingBuffer(handlers);
      const recording = buffer;
      const sub = substitution();
      if (sub?.file) {
        const bytes = new Uint8Array(await (await fetch(sub.file)).arrayBuffer());
        const sound = wavSamples(bytes);
        if (!sound) throw new Error("The substituted file is not a WAV");
        substituted = { wav: bytes };
        const samples = resamplePcm16(sound.samples, sound.sampleRate, SPEECH_SAMPLE_RATE);
        const step = Math.round(SPEECH_SAMPLE_RATE / 10);
        let at = 0;
        const timer = setInterval(
          () => {
            if (at >= samples.length) {
              // The file is over: a quiet room after it, until silence stops the recording.
              recording.push(new Int16Array(step));
              return;
            }
            recording.push(samples.subarray(at, at + step));
            at += step;
          },
          100 / (sub.speed ?? 1),
        );
        stop = () => clearInterval(timer);
        return;
      }
      substituted = null;
      const stream = await media()!.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (event) => {
        const pcm = floatToPcm16(event.inputBuffer.getChannelData(0));
        recording.push(resamplePcm16(pcm, context.sampleRate, SPEECH_SAMPLE_RATE));
      };
      source.connect(processor);
      processor.connect(context.destination);
      stop = () => {
        processor.disconnect();
        source.disconnect();
        for (const track of stream.getTracks()) track.stop();
        void context.close().catch(() => undefined);
      };
    },
    finish() {
      stop?.();
      stop = null;
      const recording = buffer;
      buffer = null;
      if (!recording) return Promise.resolve(null);
      const captured = recording.capture();
      if (substituted) {
        // The file itself goes, as it is: the test provider knows it by its code.
        const file = substituted.wav;
        substituted = null;
        const read = readWav(file);
        const sound = wavSamples(file);
        const capture: SpeechCapture = {
          wav: file,
          seconds: read.ok ? read.wav.seconds : captured.seconds,
          heardAnything: sound
            ? speechHeardAnything(
                resamplePcm16(sound.samples, sound.sampleRate, SPEECH_SAMPLE_RATE),
                SPEECH_SAMPLE_RATE,
              )
            : captured.heardAnything,
        };
        return Promise.resolve(capture);
      }
      return Promise.resolve(captured);
    },
    cancel() {
      stop?.();
      stop = null;
      buffer?.drop();
      buffer = null;
      substituted = null;
    },
    openSettings: () => Promise.resolve(),
  };
}
