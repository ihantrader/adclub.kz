import type {
  CarColorId,
  CarLevelValue,
  VehicleDocumentLevelMatch,
  VehicleGenerationSummary,
  VehicleModificationView,
  VehicleNamed,
} from "@adclub/contracts";
import { engineMatchesVolume } from "@adclub/domain";
import { spellingKey } from "../vehicles";

/**
 * Where the fields of a certificate land in the vehicle catalog (TASK-057
 * requirement 1, «сопоставление со справочником»): pure functions over the
 * answers of the client vehicle routes, so the same data the steps of
 * M-GAR-03 show decides — and every rule is a unit test.
 *
 * - a make and a model are found by every spelling the catalog keeps for
 *   them, case and spaces aside, as the search of makes does («ДЖИЛИ» →
 *   Geely through its spelling «Джили»); one spelling equal — `exact`,
 *   spellings the text begins with — `candidates`, nothing — `not_found`;
 * - the generations are the ones the year falls into;
 * - the engines are those of the modifications of that year whose size is
 *   the certificate's (1477 cm³ — the catalog's «1.5»): always to choose
 *   among, since the certificate has no engine code;
 * - the colour is one of the fixed list (D-063) by its usual words in
 *   Russian, Kazakh and English.
 */

export const NOT_FOUND: VehicleDocumentLevelMatch = {
  status: "not_found",
  value: null,
  candidates: [],
};

function exact(value: CarLevelValue): VehicleDocumentLevelMatch {
  return { status: "exact", value, candidates: [value] };
}

function among(candidates: CarLevelValue[]): VehicleDocumentLevelMatch {
  if (candidates.length === 0) return NOT_FOUND;
  return { status: "candidates", value: null, candidates };
}

/** Every spelling of a make or a model as a key. */
function keysOf(named: VehicleNamed): string[] {
  return [named.name, ...named.aliases].map(spellingKey);
}

/**
 * A make or a model by the text of the certificate. `texts` are the ways
 * the text may name it, best first (the model with and without the make in
 * front of it).
 */
export function matchNamed(
  texts: readonly (string | null)[],
  catalog: readonly VehicleNamed[],
): VehicleDocumentLevelMatch {
  const keys = texts.filter((text): text is string => !!text?.trim()).map(spellingKey);
  if (keys.length === 0) return NOT_FOUND;
  for (const key of keys) {
    const found = catalog.filter((entry) => keysOf(entry).includes(key));
    if (found.length === 1) return exact({ id: found[0]!.id, label: found[0]!.name });
    if (found.length > 1) {
      return among(found.map((entry) => ({ id: entry.id, label: entry.name })));
    }
  }
  // «COOLRAY SX11» begins with «Coolray»: a candidate, never taken by itself.
  const prefixed = catalog
    .map((entry) => ({
      entry,
      length: Math.max(
        0,
        ...keysOf(entry)
          .filter(
            (spelling) => spelling.length >= 3 && keys.some((key) => key.startsWith(spelling)),
          )
          .map((spelling) => spelling.length),
      ),
    }))
    .filter((found) => found.length > 0)
    .sort((a, b) => b.length - a.length);
  return among(prefixed.map(({ entry }) => ({ id: entry.id, label: entry.name })));
}

/**
 * The texts a model may be named by: as read, and without the make in
 * front of it when the model field repeats it («GEELY COOLRAY»).
 */
export function modelTexts(make: string | null, model: string | null): (string | null)[] {
  if (!model) return [];
  const texts: (string | null)[] = [model];
  if (make && spellingKey(model).startsWith(spellingKey(make))) {
    const rest = model.trim().slice(make.trim().length).trim();
    if (rest) texts.push(rest);
  }
  return texts;
}

/**
 * When the certificate's «Марка, модель» came back whole in the make
 * («GEELY COOLRAY», no model), the first word is the make and the rest is
 * the model.
 */
export function splitMakeModel(
  make: string | null,
  model: string | null,
): { make: string | null; model: string | null } {
  if (model?.trim() || !make) return { make, model };
  const words = make.trim().split(/\s+/u);
  if (words.length < 2) return { make, model };
  return { make: words[0]!, model: words.slice(1).join(" ") };
}

/** The generations a year falls into. No year — nothing is chosen for the person. */
export function matchGeneration(
  generations: readonly VehicleGenerationSummary[],
  year: number | null,
): VehicleDocumentLevelMatch {
  if (year === null) return NOT_FOUND;
  const covering = generations.filter(
    (generation) => year >= generation.yearFrom && year <= (generation.yearTo ?? Infinity),
  );
  const values = covering.map((generation) => ({ id: generation.id, label: generation.name }));
  if (values.length === 1) return exact(values[0]!);
  return among(values);
}

/** The engines of that year of the size the certificate states (candidates, or nothing). */
export function matchEngines(
  modifications: readonly VehicleModificationView[],
  year: number | null,
  cc: number | null,
): VehicleDocumentLevelMatch {
  if (cc === null) return NOT_FOUND;
  const seen = new Set<string>();
  const candidates: CarLevelValue[] = [];
  for (const modification of modifications) {
    if (
      year !== null &&
      (year < modification.yearFrom || year > (modification.yearTo ?? Infinity))
    ) {
      continue;
    }
    const { engine } = modification;
    if (engine.displacementL === null || !engineMatchesVolume(engine.displacementL, cc)) continue;
    if (seen.has(engine.id)) continue;
    seen.add(engine.id);
    // The label the step shows for an engine (`car-picker.ts`): its code.
    candidates.push({ id: engine.id, label: engine.code });
  }
  return among(candidates);
}

/** The words of each colour, most specific first: «тёмно-синий» before «синий». */
const COLOR_WORDS: readonly [CarColorId, readonly string[]][] = [
  ["darkBlue", ["темно синий", "темносиний", "қою көк", "dark blue", "navy"]],
  ["burgundy", ["бордовый", "бордо", "вишневый", "вишня", "қызыл күрең", "burgundy", "maroon"]],
  ["silver", ["серебристый", "серебряный", "серебро", "күміс", "silver"]],
  ["white", ["белый", "ақ", "white"]],
  ["black", ["черный", "қара", "black"]],
  ["gray", ["серый", "графит", "мокрый асфальт", "сұр", "gray", "grey"]],
  ["blue", ["синий", "голубой", "көк", "blue"]],
  ["red", ["красный", "қызыл", "red"]],
  ["green", ["зеленый", "жасыл", "green"]],
  ["brown", ["коричневый", "қоңыр", "brown"]],
  ["beige", ["бежевый", "беж", "beige"]],
  ["orange", ["оранжевый", "қызғылт сары", "orange"]],
  ["yellow", ["желтый", "сары", "yellow"]],
];

function colorText(value: string): string {
  return value
    .toLowerCase()
    .replace(/ё/gu, "е")
    .replace(/[^\p{L}]+/gu, " ")
    .trim();
}

/** The colour of the list a certificate's colour is (D-063), or `null`. */
export function matchColor(value: string | null): CarColorId | null {
  if (!value) return null;
  const text = ` ${colorText(value)} `;
  for (const [id, words] of COLOR_WORDS) {
    if (words.some((word) => text.includes(` ${word} `))) {
      return id;
    }
  }
  return null;
}
