import type { VehicleDocumentFields, VehicleDocumentResponse } from "@adclub/contracts";
import { checkVin, normalizeKzPlate } from "@adclub/domain";
import type { CarColorId } from "./car-color";
import { EMPTY_DRAFT, type CarDraft, type PickerOption } from "./car-picker";
import type { CarLevel, GarageCar } from "./garage";

/**
 * A car from a photographed registration certificate in the app (D-064,
 * TASK-057; SCREENS M-GAR-04, M-GAR-05) — the rules, as plain functions over
 * the server's answer, tested without React Native (`document-flow.test.ts`).
 *
 * The server reads the certificate and places it in the vehicle catalog;
 * the app only decides what that means for the steps and the final step:
 *
 * - what the catalog matched exactly (make, model, the generation of the
 *   year) is chosen in the draft, and the year with them — the steps start
 *   below it;
 * - what it matched among several (generations, engines of that size) and
 *   the year of a model it could not place are put first on their step and
 *   marked «распознано» — the person chooses;
 * - what it could not place at all is asked as usual, with «Распознали
 *   „…“ — выберите из списка»;
 * - the colour, the VIN and the plate wait on the final step, marked until
 *   the person changes them; nothing is saved before «Сохранить».
 */

/** What a recognised certificate brings into the steps and the final step; plain data (a route parameter). */
export interface CarRecognition {
  /** The fields as the certificate says them, checked by the server. */
  fields: VehicleDocumentFields;
  /** The levels the recognition chose, by the id it chose (the year as its number in text). */
  chosen: Partial<Record<CarLevel, string>>;
  /** Put first and marked «распознано» on their steps. */
  generationIds: string[];
  engineIds: string[];
  color: CarColorId | null;
  /** The server's signature: the saved car is marked «документ показан». */
  proof: string;
}

/** The draft the steps start from and what the recognition brings along. */
export function recognitionStart(answer: VehicleDocumentResponse): {
  draft: CarDraft;
  recognition: CarRecognition;
} {
  const draft: CarDraft = { ...EMPTY_DRAFT };
  const chosen: Partial<Record<CarLevel, string>> = {};
  const { match, fields } = answer;
  if (match.make.status === "exact" && match.make.value) {
    draft.make = match.make.value;
    chosen.make = match.make.value.id;
    if (match.model.status === "exact" && match.model.value) {
      draft.model = match.model.value;
      chosen.model = match.model.value.id;
      if (fields.year !== null) {
        draft.year = fields.year;
        chosen.year = String(fields.year);
        if (match.generation.status === "exact" && match.generation.value) {
          draft.generation = match.generation.value;
          chosen.generation = match.generation.value.id;
        }
      }
    }
  }
  return {
    draft,
    recognition: {
      fields,
      chosen,
      generationIds: match.generation.candidates.map((value) => value.id),
      engineIds: match.engine.candidates.map((value) => value.id),
      color: match.color.value,
      proof: answer.documentProof ?? "",
    },
  };
}

/** «Распознали „…“ — выберите из списка» for a step the recognition named but did not place. */
export function unplacedText(
  recognition: CarRecognition | undefined,
  step: CarLevel,
  draft: CarDraft,
): string | null {
  if (!recognition) return null;
  const { fields, chosen } = recognition;
  if (step === "make" && !chosen.make && fields.make) return fields.make;
  if (step === "model" && !chosen.model && fields.model) {
    // A model is only worth naming on the make the certificate named.
    return chosen.make === undefined || draft.make?.id === chosen.make ? fields.model : null;
  }
  if (step === "engine" && recognition.engineIds.length === 0 && fields.engineVolumeCc !== null) {
    return `${String(fields.engineVolumeCc)} см³`;
  }
  return null;
}

/**
 * The options of a step with what the recognition suggests first and
 * marked: the generations and engines it found among several, the year of
 * the certificate. Nothing is dropped — a suggestion may be wrong.
 */
export function withSuggestions(
  recognition: CarRecognition | undefined,
  step: CarLevel,
  options: readonly PickerOption[],
): { options: PickerOption[]; suggested: Set<string> } {
  const suggested = new Set<string>();
  if (recognition) {
    const ids =
      step === "generation"
        ? recognition.generationIds
        : step === "engine"
          ? recognition.engineIds
          : step === "year" && recognition.fields.year !== null
            ? [String(recognition.fields.year)]
            : [];
    for (const id of ids) {
      if (options.some((option) => option.id === id)) suggested.add(id);
    }
  }
  const first = options.filter((option) => suggested.has(option.id));
  const rest = options.filter((option) => !suggested.has(option.id));
  return { options: [...first, ...rest], suggested };
}

/** Whether a level of the final step still holds what the recognition chose («распознано»). */
export function stillRecognized(
  recognition: CarRecognition | undefined,
  draft: CarDraft,
  level: CarLevel,
): boolean {
  const id = recognition?.chosen[level];
  if (id === undefined) return false;
  if (level === "year") return draft.year !== null && String(draft.year) === id;
  return draft[level]?.id === id;
}

export type DocumentFieldError = "vin_length" | "vin_characters" | "plate";

/**
 * The VIN and the plate of the final step or the card, as the server will
 * check them (T-GAR-07): empty is allowed; anything else must be a VIN of 17
 * characters without I, O, Q, and a plate as on a Kazakhstan plate.
 */
export function checkDocumentFields(
  vin: string,
  plate: string,
): {
  vin: string | null;
  plate: string | null;
  errors: Partial<Record<"vin" | "plate", DocumentFieldError>>;
} {
  const errors: Partial<Record<"vin" | "plate", DocumentFieldError>> = {};
  let vinValue: string | null = null;
  if (vin.trim() !== "") {
    const checked = checkVin(vin);
    if (checked.ok) vinValue = checked.vin;
    else errors.vin = checked.reason === "length" ? "vin_length" : "vin_characters";
  }
  let plateValue: string | null = null;
  if (plate.trim() !== "") {
    plateValue = normalizeKzPlate(plate);
    if (plateValue === null) errors.plate = "plate";
  }
  return { vin: vinValue, plate: plateValue, errors };
}

/** What «Подтвердить техпаспортом» found against the car's own VIN and plate. */
export interface ConfirmationMerge {
  /** What fills an empty field by itself. */
  fill: { vin?: string; plate?: string };
  /** What differs from what the car already has: the person chooses. */
  conflicts: { field: "vin" | "plate"; current: string; read: string }[];
}

export function confirmationMerge(
  car: GarageCar,
  fields: VehicleDocumentFields,
): ConfirmationMerge {
  const merge: ConfirmationMerge = { fill: {}, conflicts: [] };
  for (const field of ["vin", "plate"] as const) {
    const read = fields[field];
    const current = car[field];
    if (read === null) continue;
    if (current === null) merge.fill[field] = read;
    else if (current !== read) merge.conflicts.push({ field, current, read });
  }
  return merge;
}

/**
 * What a recognition that did not give a certificate means on M-GAR-04 —
 * every state of the screen besides the camera and «Распознаём…».
 */
export type RecognitionFailure =
  "not_readable" | "other_document" | "unavailable" | "limit" | "offline" | "invalid";

/** The state of a failed call, from the error the API client threw. */
export function recognitionFailureOf(error: unknown): RecognitionFailure {
  const value = error as { code?: unknown; status?: unknown } | null;
  const code = typeof value?.code === "string" ? value.code : "";
  if (code === "NETWORK_ERROR") return "offline";
  if (code === "RATE_LIMITED") return "limit";
  if (
    code === "VEHICLE_DOCUMENT_INVALID" ||
    code === "PAYLOAD_TOO_LARGE" ||
    code === "UNSUPPORTED_MEDIA_TYPE"
  ) {
    return "invalid";
  }
  return "unavailable";
}

/** The state of an answer that is not a certificate. */
export function recognitionResultFailure(
  answer: VehicleDocumentResponse,
): RecognitionFailure | null {
  if (answer.result === "kz_registration") return null;
  return answer.result === "other_document" ? "other_document" : "not_readable";
}
