import { Inject, Injectable } from "@nestjs/common";
import { MODEL_REQUEST_SERVER_MAX_SECONDS, type VehicleDocumentAttempts } from "@adclub/contracts";
import { ApiException } from "../../common/errors";
import {
  AiBudgetExhaustedError,
  AiGatewayError,
  AiService,
  type AiCallMeta,
  type AiCallResult,
  type AiInitiator,
  type PhotoInput,
} from "../ai";
import { AppSettings } from "../settings";
import { DocumentAttempts, type DocumentReader } from "./document-attempts";
import { DocumentImageRejected, prepareDocumentImage } from "./document-image";

/** One reading of a photo: the checked answer of the model and the attempts left after it. */
/**
 * The longest a photo waits for the models, both together (TASK-063.B): the
 * rest of `MODEL_REQUEST_SERVER_MAX_SECONDS` is for preparing the picture
 * and, for a part, the catalog search — the app waits only so long.
 */
const PHOTO_MODEL_DEADLINE_MS = (MODEL_REQUEST_SERVER_MAX_SECONDS - 15) * 1000;

export interface PhotoReading<Output> {
  call: AiCallResult<Output>;
  attempts: VehicleDocumentAttempts;
}

/**
 * The one way a photo of a person reaches AI (TASK-057, TASK-058;
 * ARCHITECTURE 4.58, 4.83): the registration certificate, the dashboard and
 * a part go through here, so every one of them is counted, prepared and
 * forgotten the same way:
 *
 * 1. the size — over `vehicle_document_max_size_mb` is 413;
 * 2. the attempt is counted in the buckets of the reader — the device and
 *    the address of a guest, the account of a signed-in person — one count
 *    for the three kinds of photo (`DocumentAttempts`); over — 429;
 * 3. the photo is checked by its content, made smaller and stripped
 *    (`prepareDocumentImage`), in memory;
 * 4. a guest's call waits for `guest_ai_daily_budget_usd`;
 * 5. the operation of the gateway reads it; only its size goes to
 *    `ai_job.input_ref`.
 *
 * An attempt that did not happen through no fault of the person — a
 * picture refused, the provider down, the day's budget spent — is given
 * back. The bytes live in this call and are dropped with it: nothing writes
 * them to a table, the storage, a queue, a log line or the journal.
 */
@Injectable()
export class PhotoRecognitions {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(AiService) private readonly ai: AiService,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(DocumentAttempts) private readonly attempts: DocumentAttempts,
  ) {}

  left(reader: DocumentReader): Promise<VehicleDocumentAttempts> {
    return this.attempts.left(reader);
  }

  async read<Output>(
    reader: DocumentReader,
    body: Buffer,
    operation: (input: PhotoInput, meta: AiCallMeta) => Promise<AiCallResult<Output>>,
  ): Promise<PhotoReading<Output>> {
    const maxBytes = (await this.settings.get("vehicle_document_max_size_mb")) * 1024 * 1024;
    if (body.byteLength > maxBytes) {
      throw new ApiException(
        413,
        "PAYLOAD_TOO_LARGE",
        `The photo is larger than the limit of ${String(Math.round(maxBytes / (1024 * 1024)))} MB`,
      );
    }
    const counted = await this.attempts.count(reader);
    let image;
    try {
      image = await prepareDocumentImage(body);
    } catch (error) {
      await this.attempts.giveBack(counted.keys);
      if (error instanceof DocumentImageRejected) {
        throw new ApiException(
          400,
          "VEHICLE_DOCUMENT_INVALID",
          "The photo is not a picture the server reads",
          { details: { reason: error.reason } },
        );
      }
      throw error;
    }

    if (reader.kind === "guest") {
      const [spent, budget] = await Promise.all([
        this.ai.guestSpentToday(),
        this.settings.get("guest_ai_daily_budget_usd"),
      ]);
      if (spent >= budget) {
        await this.attempts.giveBack(counted.keys);
        throw this.unavailable("budget", counted.attempts);
      }
    }

    const initiator: AiInitiator =
      reader.kind === "account"
        ? { type: "account", id: reader.accountId }
        : { type: "guest_device", id: reader.deviceId };
    try {
      const call = await operation(
        { image: image.bytes, contentType: "image/jpeg" },
        // The size of the picture only: what it shows is never recorded.
        {
          initiator,
          inputRef: { bytes: image.bytes.byteLength, width: image.width, height: image.height },
          deadlineMs: PHOTO_MODEL_DEADLINE_MS,
        },
      );
      return { call, attempts: counted.attempts };
    } catch (error) {
      if (error instanceof AiBudgetExhaustedError) {
        await this.attempts.giveBack(counted.keys);
        throw this.unavailable("budget", counted.attempts);
      }
      if (error instanceof AiGatewayError) {
        // Down, refused, no private provider, an unusable answer: none of it
        // is the person's doing, so the attempt is given back.
        await this.attempts.giveBack(counted.keys);
        throw this.unavailable("provider", counted.attempts);
      }
      throw error;
    }
  }

  private unavailable(
    reason: "provider" | "budget",
    attempts: VehicleDocumentAttempts,
  ): ApiException {
    return new ApiException(
      503,
      "VEHICLE_DOCUMENT_UNAVAILABLE",
      "The photo can't be read now; try again later or enter it by hand",
      { details: { reason, attempts: this.attempts.refunded(attempts) }, retryable: true },
    );
  }
}
