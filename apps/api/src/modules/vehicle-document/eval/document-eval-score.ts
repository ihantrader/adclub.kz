import { normalizeKzPlate, normalizeVin } from "@adclub/domain";
import type { VehicleDocumentOutput } from "../../ai";
import { spellingKey } from "../../vehicles";
import { matchColor, modelTexts } from "../document-matching";
import type { DocumentEvalSample } from "./document-eval-data";

/**
 * How the answers of one model on the synthetic set are scored (TASK-057
 * requirement 2, D-058). Pure — the runner collects answers, this counts.
 *
 * - the kind of the picture: a certificate, another document, nothing
 *   readable; «not a document» counts as another document (the person is
 *   told the same thing). A blurred or covered certificate may also be
 *   answered «unreadable» without being wrong (`acceptKinds`);
 * - the fields — on the readable certificates only (`readable`): the VIN and
 *   the plate strictly, character for character after the server's own
 *   check; the make and the model as the catalog compares spellings; the
 *   year; the engine within 5 cm³; the colour by the colour of the list;
 * - a refusal of another document: no certificate and no field at all;
 * - a VIN hidden under a thumb that is read anyway — a guess, counted apart.
 *
 * The threshold (D-058, the task): VIN and plate ≥ 95 % on the readable
 * certificates, the kind ≥ 98 % on the whole set.
 */

export const DOCUMENT_THRESHOLD = { vin: 0.95, plate: 0.95, kind: 0.98 } as const;

export type DocumentField =
  "make" | "model" | "year" | "vin" | "plate" | "engineVolumeCc" | "color";

export const DOCUMENT_FIELDS: readonly DocumentField[] = [
  "make",
  "model",
  "year",
  "vin",
  "plate",
  "engineVolumeCc",
  "color",
];

type Kind = "kz_registration" | "other_document" | "unreadable";

function kindOf(value: VehicleDocumentOutput["documentKind"]): Kind {
  return value === "not_document" ? "other_document" : value;
}

export function kindCorrect(sample: DocumentEvalSample, answer: VehicleDocumentOutput): boolean {
  const got = kindOf(answer.documentKind);
  const expected =
    sample.expected.documentKind === "not_document"
      ? "other_document"
      : sample.expected.documentKind;
  return (
    got === expected || (sample.acceptKinds ?? []).includes(got as "kz_registration" | "unreadable")
  );
}

export function fieldCorrect(
  sample: DocumentEvalSample,
  answer: VehicleDocumentOutput,
  field: DocumentField,
): boolean {
  const expected = sample.expected;
  switch (field) {
    case "vin":
      return normalizeVin(answer.vin) === expected.vin;
    case "plate":
      return normalizeKzPlate(answer.plate) === expected.plate;
    case "year":
      return answer.year === expected.year;
    case "make":
      return (
        answer.make !== null &&
        expected.make !== null &&
        spellingKey(answer.make) === spellingKey(expected.make)
      );
    case "model":
      return (
        expected.model !== null &&
        modelTexts(answer.make, answer.model).some(
          (text) => text !== null && spellingKey(text) === spellingKey(expected.model!),
        )
      );
    case "engineVolumeCc":
      return (
        answer.engineVolumeCc !== null &&
        expected.engineVolumeCc !== null &&
        Math.abs(answer.engineVolumeCc - expected.engineVolumeCc) <= 5
      );
    case "color":
      return matchColor(answer.color) === expected.colorId;
  }
}

/** Another document turned down: not a certificate, and not one field read from it. */
export function refusedForeign(answer: VehicleDocumentOutput): boolean {
  return (
    kindOf(answer.documentKind) !== "kz_registration" &&
    DOCUMENT_FIELDS.every((field) => answer[field] === null)
  );
}

export interface DocumentScore {
  samples: number;
  answered: number;
  kind: { correct: number; total: number; share: number };
  /** Per field, on the readable certificates. */
  fields: Record<DocumentField, { correct: number; total: number; share: number }>;
  foreign: { refused: number; total: number };
  /** VINs read where the set has them hidden. */
  guessedHiddenVin: number;
  passes: boolean;
  /** Which sample went wrong how, for a person to look at. */
  misses: { sampleId: string; what: string; expected: string; got: string }[];
}

function share(correct: number, total: number): number {
  return total === 0 ? 0 : Math.round((correct / total) * 1000) / 1000;
}

/**
 * Scores what one model answered. A sample without an answer (the call
 * failed) counts as wrong: a comparison must not look better for a model
 * that fails.
 */
export function scoreDocuments(
  samples: readonly DocumentEvalSample[],
  answers: ReadonlyMap<string, VehicleDocumentOutput>,
): DocumentScore {
  const fields = Object.fromEntries(
    DOCUMENT_FIELDS.map((field) => [field, { correct: 0, total: 0, share: 0 }]),
  ) as DocumentScore["fields"];
  const misses: DocumentScore["misses"] = [];
  let kindRight = 0;
  let foreignTotal = 0;
  let foreignRefused = 0;
  let guessedHiddenVin = 0;
  for (const sample of samples) {
    const answer = answers.get(sample.id);
    const isCertificate = sample.expected.documentKind === "kz_registration";
    if (answer && kindCorrect(sample, answer)) {
      kindRight += 1;
    } else {
      misses.push({
        sampleId: sample.id,
        what: "kind",
        expected: sample.expected.documentKind,
        got: answer?.documentKind ?? "(no answer)",
      });
    }
    if (!isCertificate) {
      foreignTotal += 1;
      if (answer && refusedForeign(answer)) foreignRefused += 1;
      continue;
    }
    if (sample.variant === "occluded" && answer?.vin) {
      guessedHiddenVin += 1;
    }
    if (!sample.readable) continue;
    for (const field of DOCUMENT_FIELDS) {
      fields[field].total += 1;
      if (answer && fieldCorrect(sample, answer, field)) {
        fields[field].correct += 1;
      } else {
        const expectedValue = field === "color" ? sample.expected.colorId : sample.expected[field];
        misses.push({
          sampleId: sample.id,
          what: field,
          expected: String(expectedValue),
          got: answer ? String(answer[field]) : "(no answer)",
        });
      }
    }
  }
  for (const field of DOCUMENT_FIELDS) {
    fields[field].share = share(fields[field].correct, fields[field].total);
  }
  const kindShare = share(kindRight, samples.length);
  return {
    samples: samples.length,
    answered: samples.filter((sample) => answers.has(sample.id)).length,
    kind: { correct: kindRight, total: samples.length, share: kindShare },
    fields,
    foreign: { refused: foreignRefused, total: foreignTotal },
    guessedHiddenVin,
    passes:
      fields.vin.share >= DOCUMENT_THRESHOLD.vin &&
      fields.plate.share >= DOCUMENT_THRESHOLD.plate &&
      kindShare >= DOCUMENT_THRESHOLD.kind,
    misses,
  };
}
