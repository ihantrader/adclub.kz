import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  ASSISTANT_MESSAGE_MAX_CHARS,
  MODEL_REQUEST_SERVER_MAX_SECONDS,
  type SpeechPurpose,
  type SpeechTranscription,
  type VehicleDocumentAttempts,
} from "@adclub/contracts";
import {
  cleanSpeechText,
  readWav,
  speechAttemptCharge,
  SPEECH_TEXT_MAX_LENGTH,
} from "@adclub/domain";
import type { Lang } from "@adclub/i18n";
import { ApiException } from "../../common/errors";
import { AiBudgetExhaustedError, AiGatewayError, AiService, type AiInitiator } from "../ai";
import { AppSettings } from "../settings";
import type { DocumentReader } from "../vehicle-document";
import { SpeechAttempts } from "./speech-attempts";

/**
 * The longest a recording waits for the models, both together: within what
 * the app waits for a `waitsForModel` request (TASK-063.B).
 */
const SPEECH_MODEL_DEADLINE_MS = (MODEL_REQUEST_SERVER_MAX_SECONDS - 15) * 1000;

/** A recording a little over the limit is the app's timer, not a person: half a second is let through. */
const LENGTH_TOLERANCE_SECONDS = 0.5;

/**
 * How long the text of each field may be (TASK-060): a message to the
 * assistant takes what the message field takes; the search line, the
 * mileage and a car to add take a line.
 */
export function speechTextMaxLength(purpose: SpeechPurpose): number {
  return purpose === "assistant" ? ASSISTANT_MESSAGE_MAX_CHARS : SPEECH_TEXT_MAX_LENGTH;
}

/**
 * Voice input (TASK-059; SCREENS M-CAT-05; ARCHITECTURE 4.90) — the one way
 * a recording reaches AI, built as the photos are (`PhotoRecognitions`):
 *
 * 1. the size (`speech_max_size_kb`) — over it 413, nothing counted;
 * 2. the format by the content (`readWav`: WAV, 16-bit PCM) — anything else
 *    400 `SPEECH_INVALID`; the length (`speech_max_seconds`) — over it 413;
 *    nothing counted for either;
 * 3. the attempt is counted in the buckets of the reader (`SpeechAttempts`);
 *    over one — 429 with `details.limit`;
 * 4. a guest's call waits for `guest_ai_daily_budget_usd`;
 * 5. the model hears it through `AiService` (the daily budget, `ai_job`
 *    with the size and the length only, providers that keep nothing);
 * 6. the answer is cleaned for the field it is said into (`cleanSpeechText`
 *    to the length of `purpose`; one letter or digit — nothing heard).
 *
 * `purpose` (TASK-060) also tells the model what is said there; the
 * limits, the attempts and what is kept are one for every purpose.
 *
 * An attempt the provider could not serve is given back
 * (`speechAttemptCharge`). The bytes live in this call and are dropped with
 * it: nothing writes them to a table, the storage, a queue, a log line or
 * the journal — and the text is not written anywhere either.
 */
@Injectable()
export class SpeechRecognitions {
  private readonly logger = new Logger("Speech");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(AiService) private readonly ai: AiService,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(SpeechAttempts) private readonly attempts: SpeechAttempts,
  ) {}

  async transcribe(
    reader: DocumentReader,
    body: Buffer,
    language: Lang,
    purpose: SpeechPurpose = "search",
  ): Promise<SpeechTranscription> {
    const [maxKb, maxSeconds] = await Promise.all([
      this.settings.get("speech_max_size_kb"),
      this.settings.get("speech_max_seconds"),
    ]);
    const maxBytes = maxKb * 1024;
    const tooLarge = (reason: "duration" | "size") =>
      new ApiException(
        413,
        "PAYLOAD_TOO_LARGE",
        reason === "size"
          ? `The recording is larger than the limit of ${String(maxKb)} KB`
          : `The recording is longer than the limit of ${String(maxSeconds)} seconds`,
        { details: { reason, maxSeconds, maxBytes } },
      );
    // Refused before anything is counted (speechAttemptCharge: not_counted).
    if (body.byteLength > maxBytes) throw tooLarge("size");
    const read = readWav(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
    if (!read.ok) {
      throw new ApiException(
        400,
        "SPEECH_INVALID",
        "The body is not a recording the server reads",
        {
          details: {
            reason: read.reason,
            ...(read.reason === "unsupported_format" ? { detected: read.detected } : {}),
          },
        },
      );
    }
    if (read.wav.seconds > maxSeconds + LENGTH_TOLERANCE_SECONDS) {
      throw tooLarge("duration");
    }

    const counted = await this.attempts.count(reader);
    const giveBack = async (reason: "provider" | "budget") => {
      if (
        speechAttemptCharge(reason === "budget" ? "budget_spent" : "provider_unavailable") ===
        "given_back"
      ) {
        await this.attempts.giveBack(counted.keys);
      }
      return this.unavailable(reason, counted.attempts);
    };
    if (reader.kind === "guest") {
      const [spent, budget] = await Promise.all([
        this.ai.guestSpentToday(),
        this.settings.get("guest_ai_daily_budget_usd"),
      ]);
      if (spent >= budget) throw await giveBack("budget");
    }

    const initiator: AiInitiator =
      reader.kind === "account"
        ? { type: "account", id: reader.accountId }
        : { type: "guest_device", id: reader.deviceId };
    let output;
    try {
      ({ output } = await this.ai.transcribeSpeech(
        {
          audio: new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
          format: "wav",
          seconds: read.wav.seconds,
          language,
          purpose,
        },
        // The size and the length only: what was said is never recorded.
        {
          initiator,
          inputRef: {
            bytes: body.byteLength,
            seconds: Math.round(read.wav.seconds * 10) / 10,
            sampleRate: read.wav.sampleRate,
          },
          deadlineMs: SPEECH_MODEL_DEADLINE_MS,
        },
      ));
    } catch (error) {
      if (error instanceof AiBudgetExhaustedError) throw await giveBack("budget");
      // Down, refused, no private provider, an unusable answer: none of it
      // is the person's doing, so the attempt is given back.
      if (error instanceof AiGatewayError) throw await giveBack("provider");
      throw error;
    }
    const whole = cleanSpeechText(output.text, speechTextMaxLength(purpose));
    // A message to the assistant comes whole in `message`; `text` keeps the
    // length of a line (the contract is only added to, TASK-060).
    const cleaned =
      purpose === "assistant"
        ? {
            ...whole,
            text: cleanSpeechText(whole.text, SPEECH_TEXT_MAX_LENGTH).text,
            message: whole.text,
          }
        : whole;
    // Whether something was heard and how long the recording was — never what was said.
    this.logger.log(
      `Speech transcribed purpose=${purpose} heard=${String(cleaned.heard)} cut=${String(cleaned.cut)} seconds=${read.wav.seconds.toFixed(1)}`,
    );
    return { ...cleaned, attempts: counted.attempts };
  }

  private unavailable(
    reason: "provider" | "budget",
    attempts: VehicleDocumentAttempts,
  ): ApiException {
    return new ApiException(
      503,
      "SPEECH_UNAVAILABLE",
      "Voice input is unavailable now; type the query instead",
      { details: { reason, attempts: this.attempts.refunded(attempts) }, retryable: true },
    );
  }
}
