import { Inject, Injectable, Logger } from "@nestjs/common";
import type {
  VehicleDocumentAttempts,
  VehicleDocumentFields,
  VehicleDocumentKind,
  VehicleDocumentMatch,
  VehicleDocumentResponse,
  VehicleGenerationSummary,
  VehicleModificationView,
} from "@adclub/contracts";
import { engineVolumeCc, normalizeKzPlate, normalizeVin } from "@adclub/domain";
import { ApiException } from "../../common/errors";
import {
  AiBudgetExhaustedError,
  AiGatewayError,
  AiService,
  type AiInitiator,
  type VehicleDocumentOutput,
} from "../ai";
import { AppSettings } from "../settings";
import { VehicleReadService } from "../vehicles";
import { DocumentAttempts, type DocumentReader } from "./document-attempts";
import { DocumentImageRejected, prepareDocumentImage } from "./document-image";
import {
  matchColor,
  matchEngines,
  matchGeneration,
  matchNamed,
  modelTexts,
  NOT_FOUND,
  splitMakeModel,
} from "./document-matching";
import { DocumentProofs } from "./document-proofs";

const NO_FIELDS: VehicleDocumentFields = {
  make: null,
  model: null,
  year: null,
  vin: null,
  plate: null,
  engineVolumeCc: null,
  color: null,
};

const NO_MATCH: VehicleDocumentMatch = {
  make: NOT_FOUND,
  model: NOT_FOUND,
  generation: NOT_FOUND,
  engine: NOT_FOUND,
  color: { status: "not_found", value: null },
};

/** A text field of the answer as the client gets it: trimmed, bounded, never empty. */
function textOf(value: string | null, max: number): string | null {
  const text = value?.replace(/\s+/gu, " ").trim() ?? "";
  return text === "" ? null : text.slice(0, max);
}

/**
 * The fields of an answer, checked (TASK-057 requirement 1): a VIN that is
 * not one and a plate that is not a Kazakhstan plate are `null` — never a
 * guess and never a correction — and a year or an engine size out of reason
 * is dropped too. Everything the model added beyond these fields was
 * already dropped by the schema of the operation.
 */
export function documentFields(
  output: VehicleDocumentOutput,
  currentYear: number,
): VehicleDocumentFields {
  const named = splitMakeModel(textOf(output.make, 100), textOf(output.model, 100));
  return {
    make: named.make,
    model: named.model,
    year:
      output.year !== null && output.year >= 1950 && output.year <= currentYear + 1
        ? output.year
        : null,
    vin: normalizeVin(output.vin),
    plate: normalizeKzPlate(output.plate),
    engineVolumeCc: engineVolumeCc(output.engineVolumeCc),
    color: textOf(output.color, 60),
  };
}

/** The kind the client is told: a picture that is not a document is «не тот документ» to a person. */
export function documentKind(
  output: VehicleDocumentOutput,
  fields: VehicleDocumentFields,
): VehicleDocumentKind {
  if (output.documentKind === "kz_registration") {
    // A certificate nothing could be read from is, to the person, unreadable.
    const anything =
      fields.make !== null || fields.model !== null || fields.vin !== null || fields.plate !== null;
    return anything ? "kz_registration" : "unreadable";
  }
  return output.documentKind === "unreadable" ? "unreadable" : "other_document";
}

/**
 * Reading a car off a photographed Kazakhstan registration certificate
 * (D-064, TASK-057; SCREENS M-GAR-04): the attempt is counted, the photo is
 * made smaller and stripped, the AI gateway reads it, the fields are checked
 * and placed in the vehicle catalog — and the photo is dropped with the
 * request. Nothing of the photo is written anywhere: not in a table, not in
 * the storage, not in a queue, not in `ai_job` (its size only), not in a
 * log line, not in the journal. Nothing is added to the garage either:
 * that happens when the person has checked the result and pressed
 * «Сохранить».
 */
@Injectable()
export class VehicleDocumentService {
  private readonly logger = new Logger("VehicleDocument");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(AiService) private readonly ai: AiService,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(DocumentAttempts) private readonly attempts: DocumentAttempts,
    @Inject(VehicleReadService) private readonly vehicles: VehicleReadService,
    @Inject(DocumentProofs) private readonly proofs: DocumentProofs,
  ) {}

  left(reader: DocumentReader): Promise<VehicleDocumentAttempts> {
    return this.attempts.left(reader);
  }

  async recognize(reader: DocumentReader, body: Buffer): Promise<VehicleDocumentResponse> {
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
          {
            details: { reason: error.reason },
          },
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
    let output: VehicleDocumentOutput;
    try {
      const result = await this.ai.readVehicleDocument(
        { image: image.bytes, contentType: "image/jpeg" },
        // The size of the picture only: what it shows is never recorded.
        {
          initiator,
          inputRef: { bytes: image.bytes.byteLength, width: image.width, height: image.height },
        },
      );
      output = result.output;
    } catch (error) {
      if (error instanceof AiBudgetExhaustedError) {
        await this.attempts.giveBack(counted.keys);
        throw this.unavailable("budget", counted.attempts);
      }
      if (error instanceof AiGatewayError) {
        // Down, refused, no private provider, an unusable answer: none of it
        // is the person's doing, so the attempt is given back (requirement 1).
        await this.attempts.giveBack(counted.keys);
        throw this.unavailable("provider", counted.attempts);
      }
      throw error;
    }

    const fields = documentFields(output, new Date().getFullYear());
    const kind = documentKind(output, fields);
    // The kind and which fields came back — never their values.
    this.logger.log(
      `Vehicle document read result=${kind} fields=${Object.entries(fields)
        .filter(([, value]) => value !== null)
        .map(([key]) => key)
        .join(",")}`,
    );
    if (kind !== "kz_registration") {
      return {
        result: kind,
        fields: NO_FIELDS,
        match: NO_MATCH,
        documentProof: null,
        attempts: counted.attempts,
      };
    }
    return {
      result: kind,
      fields,
      match: await this.match(fields),
      documentProof: this.proofs.issue(new Date()),
      attempts: counted.attempts,
    };
  }

  /** The fields placed in the vehicle catalog, through the very routes the steps read. */
  private async match(fields: VehicleDocumentFields): Promise<VehicleDocumentMatch> {
    const color = matchColor(fields.color);
    const result: VehicleDocumentMatch = {
      ...NO_MATCH,
      color:
        color === null ? { status: "not_found", value: null } : { status: "exact", value: color },
    };
    const { makes } = await this.vehicles.makes("ru");
    result.make = matchNamed([fields.make], makes);
    if (result.make.status !== "exact" || !result.make.value) {
      return result;
    }
    const { models } = await this.vehicles.models(result.make.value.id, "ru");
    result.model = matchNamed(modelTexts(fields.make, fields.model), models);
    if (result.model.status !== "exact" || !result.model.value) {
      return result;
    }
    const { generations } = await this.vehicles.generations(result.model.value.id, "ru");
    result.generation = matchGeneration(generations, fields.year);
    result.engine = matchEngines(
      await this.modificationsOf(
        result.generation.candidates.length > 0
          ? result.generation.candidates.map((value) => value.id)
          : generations.map((generation: VehicleGenerationSummary) => generation.id),
      ),
      fields.year,
      fields.engineVolumeCc,
    );
    return result;
  }

  private async modificationsOf(
    generationIds: readonly string[],
  ): Promise<VehicleModificationView[]> {
    const answers = await Promise.all(
      generationIds.map((id) => this.vehicles.modifications(id, "ru", undefined)),
    );
    return answers.flatMap((answer) => answer.modifications);
  }

  private unavailable(
    reason: "provider" | "budget",
    attempts: VehicleDocumentAttempts,
  ): ApiException {
    return new ApiException(
      503,
      "VEHICLE_DOCUMENT_UNAVAILABLE",
      "The certificate can't be read now; choose the car from the list",
      { details: { reason, attempts: this.attempts.refunded(attempts) }, retryable: true },
    );
  }
}
