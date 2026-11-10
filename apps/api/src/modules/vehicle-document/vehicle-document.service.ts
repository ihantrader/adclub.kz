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
import { AiService, type VehicleDocumentOutput } from "../ai";
import { VehicleReadService } from "../vehicles";
import type { DocumentReader } from "./document-attempts";
import { PhotoRecognitions } from "./photo-recognitions";
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
    @Inject(PhotoRecognitions) private readonly photos: PhotoRecognitions,
    @Inject(AiService) private readonly ai: AiService,
    @Inject(VehicleReadService) private readonly vehicles: VehicleReadService,
    @Inject(DocumentProofs) private readonly proofs: DocumentProofs,
  ) {}

  left(reader: DocumentReader): Promise<VehicleDocumentAttempts> {
    return this.photos.left(reader);
  }

  async recognize(reader: DocumentReader, body: Buffer): Promise<VehicleDocumentResponse> {
    const reading = await this.photos.read(reader, body, (input, meta) =>
      this.ai.readVehicleDocument(input, meta),
    );
    const output: VehicleDocumentOutput = reading.call.output;
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
        attempts: reading.attempts,
      };
    }
    return {
      result: kind,
      fields,
      match: await this.match(fields),
      documentProof: this.proofs.issue(new Date()),
      attempts: reading.attempts,
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
}
