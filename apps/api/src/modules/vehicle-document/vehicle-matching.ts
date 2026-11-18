import { Inject, Injectable } from "@nestjs/common";
import type {
  VehicleDocumentFields,
  VehicleDocumentLevelMatch,
  VehicleDocumentMatch,
  VehicleGenerationSummary,
  VehicleMatchResponse,
  VehicleModificationView,
  VehicleNamed,
} from "@adclub/contracts";
import {
  latestVehicleYear,
  readVehiclePhrase,
  vehicleNameSpans,
  vehicleNameSpellings,
  vehicleYearOf,
} from "@adclub/domain";
import { VehicleReadService } from "../vehicles";
import {
  matchColor,
  matchEngines,
  matchGeneration,
  matchNamed,
  modelTexts,
  NOT_FOUND,
} from "./document-matching";

export const NO_MATCH: VehicleDocumentMatch = {
  make: NOT_FOUND,
  model: NOT_FOUND,
  generation: NOT_FOUND,
  engine: NOT_FOUND,
  color: { status: "not_found", value: null },
};

/** A level found among the runs of words, and the words it took. */
interface Placed {
  match: VehicleDocumentLevelMatch;
  span: { from: number; to: number; text: string } | null;
}

/**
 * Where a car lands in the vehicle catalog (TASK-057, TASK-060): the fields
 * of a photographed certificate, or the words of a car named by voice. One
 * way below the model for both — the generations of the year and the engines
 * of the size (`matchGeneration`, `matchEngines` of `document-matching.ts`),
 * read through the very client routes the steps of M-GAR-03 read.
 */
@Injectable()
export class VehicleMatching {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(VehicleReadService) private readonly vehicles: VehicleReadService) {}

  /** The fields of a certificate placed in the catalog (TASK-057). */
  async certificate(fields: VehicleDocumentFields): Promise<VehicleDocumentMatch> {
    const result: VehicleDocumentMatch = { ...NO_MATCH, color: colorOf(fields.color) };
    const { makes } = await this.vehicles.makes("ru");
    result.make = matchNamed([fields.make], makes);
    if (result.make.status !== "exact" || !result.make.value) return result;
    const { models } = await this.vehicles.models(result.make.value.id, "ru");
    result.model = matchNamed(modelTexts(fields.make, fields.model), models);
    return this.belowModel(result, fields.year, fields.engineVolumeCc);
  }

  /**
   * A car named in words (TASK-060): the phrase taken apart
   * (`readVehiclePhrase`), the make among its runs of words by every
   * spelling of the catalog and in both alphabets (`vehicleNameSpans`),
   * the model among the words the make did not take, then the same way
   * below the model as a certificate.
   */
  async phrase(text: string, at: Date): Promise<VehicleMatchResponse> {
    const phrase = readVehiclePhrase(text, latestVehicleYear(at));
    const result: VehicleDocumentMatch = { ...NO_MATCH, color: colorOf(text) };
    const fields: VehicleDocumentFields = {
      make: null,
      model: null,
      year: phrase.year,
      vin: null,
      plate: null,
      engineVolumeCc: phrase.engineVolumeCc,
      color: null,
    };
    const { makes } = await this.vehicles.makes("ru");
    const make = placeAmong(phrase.words, null, makes);
    result.make = make.match;
    fields.make = make.span?.text ?? null;
    if (result.make.status !== "exact" || !result.make.value) {
      return { result: "not_found", fields, match: result };
    }
    const { models } = await this.vehicles.models(result.make.value.id, "ru");
    let model = placeAmong(phrase.words, make.span, models);
    // A model named by four digits («Peugeot 2008 2020»): the years taken out
    // of the words are put back, and the number the model took is no year
    // (TASK-060.A).
    if (model.match.status !== "exact" && phrase.years.length > 0) {
      const makeAgain = placeAmong(phrase.wordsWithYears, null, makes);
      if (makeAgain.match.value?.id === result.make.value.id) {
        const again = placeAmong(phrase.wordsWithYears, makeAgain.span, models);
        if (again.match.status === "exact") model = again;
      }
    }
    result.model = model.match;
    fields.model = model.span?.text ?? null;
    fields.year = vehicleYearOf(
      phrase.years,
      model.match.status === "exact" ? (model.span?.text ?? null) : null,
    );
    return {
      result: "found",
      fields,
      match: await this.belowModel(result, fields.year, phrase.engineVolumeCc),
    };
  }

  /** The generation of the year and the engines of the size, once the model is exact. */
  private async belowModel(
    result: VehicleDocumentMatch,
    year: number | null,
    cc: number | null,
  ): Promise<VehicleDocumentMatch> {
    if (result.model.status !== "exact" || !result.model.value) return result;
    const { generations } = await this.vehicles.generations(result.model.value.id, "ru");
    result.generation = matchGeneration(generations, year);
    result.engine = matchEngines(
      await this.modificationsOf(
        result.generation.candidates.length > 0
          ? result.generation.candidates.map((value) => value.id)
          : generations.map((generation: VehicleGenerationSummary) => generation.id),
      ),
      year,
      cc,
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

function colorOf(text: string | null): VehicleDocumentMatch["color"] {
  const color = matchColor(text);
  return color === null ? { status: "not_found", value: null } : { status: "exact", value: color };
}

/**
 * A make or a model among the words said: the first run of words (longer
 * first, then in the order said) one of whose spellings is exactly a name
 * of the catalog; none — the names that all the words left begin with
 * (`matchNamed`, as «COOLRAY SX11» of a certificate), as candidates.
 */
function placeAmong(
  words: readonly string[],
  taken: { from: number; to: number } | null,
  catalog: readonly VehicleNamed[],
): Placed {
  const spans = vehicleNameSpans(words, taken);
  for (const span of spans) {
    for (const spelling of span.spellings) {
      const match = matchNamed([spelling], catalog);
      if (match.status === "exact") return { match, span };
    }
  }
  const rest = words.filter((_, index) => !taken || index < taken.from || index >= taken.to);
  if (rest.length === 0) return { match: NOT_FOUND, span: null };
  const text = rest.join(" ");
  const match = matchNamed(vehicleNameSpellings(text), catalog);
  return { match, span: match.status === "not_found" ? null : { from: 0, to: 0, text } };
}
