/**
 * The level of the microphone while a person speaks (TASK-059; SCREENS
 * M-CAT-05 «индикатор»), and when a recording stops by itself: after the
 * person has spoken and then kept silent (`SPEECH_SILENCE_STOP_MS`), or at
 * the limit of its length. Computed from the PCM the app records on every
 * platform the same way, so the rule is the same on iOS, Android and in a
 * browser.
 */

/** The window the level is measured in, milliseconds. */
export const SPEECH_LEVEL_WINDOW_MS = 50;
/** Below this RMS (about −40 dBFS) a window is silence. */
export const SPEECH_SILENCE_RMS = 0.01;
/** At or above this RMS (about −32 dBFS) a window is speech. */
export const SPEECH_VOICE_RMS = 0.025;
/** Silence after speech this long stops the recording. */
export const SPEECH_SILENCE_STOP_MS = 1_600;
/** How much speech counts as «the person started speaking», milliseconds. */
export const SPEECH_MIN_VOICE_MS = 150;

/** The RMS of samples, 0…1. */
export function pcmRms(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index]! / 32_768;
    sum += value * value;
  }
  return Math.sqrt(sum / samples.length);
}

/** An RMS as the indicator shows it, 0…1: −50 dBFS and below is 0, −10 dBFS and above is 1. */
export function levelOfRms(rms: number): number {
  if (rms <= 0) return 0;
  const db = 20 * Math.log10(rms);
  return Math.max(0, Math.min(1, (db + 50) / 40));
}

export interface SpeechWatchState {
  /** The indicator, 0…1, of the last window. */
  level: number;
  /** The person has spoken (enough windows above the voice level). */
  spoke: boolean;
  /** Seconds recorded. */
  seconds: number;
  /** Stop now: silence after speech, or the length limit. */
  stop: "silence" | "limit" | null;
}

/**
 * Watches the samples as they come: the level, whether the person spoke,
 * when to stop. `maxSeconds` — the length limit (`speech_max_seconds`).
 */
export function createSpeechWatch(options: { sampleRate: number; maxSeconds: number }) {
  const window = Math.max(1, Math.round((options.sampleRate * SPEECH_LEVEL_WINDOW_MS) / 1000));
  let pendingCount = 0;
  let pendingSquares = 0;
  let total = 0;
  let voiceMs = 0;
  let silenceMs = 0;
  let spoke = false;
  let level = 0;
  return {
    push(samples: Int16Array): SpeechWatchState {
      for (let index = 0; index < samples.length; index += 1) {
        const value = samples[index]! / 32_768;
        pendingSquares += value * value;
        pendingCount += 1;
        if (pendingCount >= window) {
          const rms = Math.sqrt(pendingSquares / pendingCount);
          pendingCount = 0;
          pendingSquares = 0;
          level = levelOfRms(rms);
          if (rms >= SPEECH_VOICE_RMS) {
            voiceMs += SPEECH_LEVEL_WINDOW_MS;
            silenceMs = 0;
            if (voiceMs >= SPEECH_MIN_VOICE_MS) spoke = true;
          } else if (rms < SPEECH_SILENCE_RMS) {
            silenceMs += SPEECH_LEVEL_WINDOW_MS;
          }
        }
      }
      total += samples.length;
      const seconds = total / options.sampleRate;
      const stop =
        seconds >= options.maxSeconds
          ? "limit"
          : spoke && silenceMs >= SPEECH_SILENCE_STOP_MS
            ? "silence"
            : null;
      return { level, spoke, seconds, stop };
    },
  };
}

/**
 * Whether a whole recording holds anything that could be speech: one
 * stretch of windows at the voice level. A recording without it is not
 * sent — «Не расслышали» at once, and no attempt of the limit is spent.
 */
export function speechHeardAnything(samples: Int16Array, sampleRate: number): boolean {
  const watch = createSpeechWatch({ sampleRate, maxSeconds: Number.POSITIVE_INFINITY });
  return watch.push(samples).spoke;
}
