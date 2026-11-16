import { z } from "zod";
import { vehicleDocumentAttemptsSchema } from "./vehicle-document";

/**
 * Voice input (TASK-059; SCREENS M-CAT-05; ARCHITECTURE 4.90): a recording
 * is the body of one request, read by a language model through the AI
 * gateway (D-055) and gone with the answer — stored nowhere (the database,
 * the storage, a log line, monitoring). The answer is the text only: the
 * app puts it into the search line and searches with the very
 * `GET /catalog/search` a typed query uses.
 *
 * The one format is WAV with 16-bit PCM — the app writes it itself on every
 * platform from the microphone's samples; the server checks it by its
 * content, not by the declared type.
 *
 * Refusals:
 * - `SPEECH_INVALID` (400): the bytes are not a WAV the server reads;
 *   `details` is `SpeechInvalidDetails`. No attempt is counted.
 * - `PAYLOAD_TOO_LARGE` (413): longer than `speech_max_seconds` or larger
 *   than `speech_max_size_kb`; `details` is `SpeechTooLargeDetails`. No
 *   attempt is counted; nothing reaches the model.
 * - `RATE_LIMITED` (429): `details.limit` is `speech_per_device` (a guest's
 *   trial voice requests, `guest_limits.voice_requests`, for good),
 *   `speech_per_ip` or `speech_per_account` — the app shows M-AI-02.
 * - `SPEECH_UNAVAILABLE` (503): the provider can't serve it now or the
 *   day's AI budget (of guests or of everyone) is spent; the attempt was
 *   given back. «Голосовой ввод временно недоступен».
 */

/** What the server reads of a body at most; `speech_max_size_kb` is the real limit below it. */
export const SPEECH_MAX_BYTES = 4 * 1024 * 1024;

/** The declared types a recording is sent with; what it is, the server reads from its content. */
export const SPEECH_CONTENT_TYPES = ["audio/wav", "audio/x-wav", "audio/wave"] as const;

/** `deviceId` — a guest's trial voice requests are counted by the device (as photos). */
export const speechQuerySchema = z.object({
  deviceId: z.uuid().optional(),
});

export type SpeechQuery = z.infer<typeof speechQuerySchema>;

/**
 * - `text` — what was said, as the search line takes it: the model's words
 *   only, at most 100 characters (cut by a word, `cut`); empty when nothing
 *   was heard — «Не расслышали, попробуйте ещё раз».
 * - `attempts` — what is left of the limit after this one: a guest's trial
 *   voice requests on this device, or the account's of the day.
 */
export const speechTranscriptionSchema = z.object({
  text: z.string().max(100),
  heard: z.boolean(),
  cut: z.boolean(),
  attempts: vehicleDocumentAttemptsSchema,
});

export type SpeechTranscription = z.infer<typeof speechTranscriptionSchema>;

/**
 * Why a body is not a recording the server reads: `not_audio` — not sound
 * at all; `unsupported_format` — sound of another format (`detected`:
 * `ogg`, `mp4`, `webm`, `mp3`, `aac`, `flac`, …), the app sends WAV;
 * `unsupported_encoding` — a WAV, but not 16-bit PCM; `broken`; `empty`.
 */
export const speechInvalidReasonSchema = z.enum([
  "not_audio",
  "unsupported_format",
  "unsupported_encoding",
  "broken",
  "empty",
]);

export const speechInvalidDetailsSchema = z.object({
  reason: speechInvalidReasonSchema,
  detected: z.string().optional(),
});

export type SpeechInvalidDetails = z.infer<typeof speechInvalidDetailsSchema>;

/** `details` of 413 for a recording: `duration` — longer than `maxSeconds`; `size` — larger than `maxBytes`. */
export const speechTooLargeDetailsSchema = z.object({
  reason: z.enum(["duration", "size"]),
  maxSeconds: z.number().int(),
  maxBytes: z.number().int(),
});

export type SpeechTooLargeDetails = z.infer<typeof speechTooLargeDetailsSchema>;

/**
 * `details` of `SPEECH_UNAVAILABLE`: `provider` — the AI provider can't be
 * reached; `budget` — the day's AI budget is spent (a guest's: of guests).
 * The attempt was not counted.
 */
export const speechUnavailableDetailsSchema = z.object({
  reason: z.enum(["provider", "budget"]),
  attempts: vehicleDocumentAttemptsSchema,
});

export type SpeechUnavailableDetails = z.infer<typeof speechUnavailableDetailsSchema>;
