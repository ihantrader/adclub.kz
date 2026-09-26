import type {
  VehicleGenerationSummary,
  VehicleModificationView,
  VehicleNamed,
} from "@adclub/contracts";
import { CAR_LEVELS, type CarLevel, type CarLevelValue, type GarageCar } from "./garage";

/**
 * The step-by-step choice of a car (SCREENS M-GAR-03), as pure rules over
 * the data of `/vehicles/…` (TASK-014). The app never invents a make, a
 * year or an engine: every option here comes from an answer of the server,
 * and these functions only decide **which step is next and what is on it**:
 *
 * - the order is Make → Model → Year → Generation → Body → Engine →
 *   Transmission → Drive;
 * - a step with a single option is taken automatically, a step with none is
 *   skipped (the catalog of cars is incomplete in places, and a dead end
 *   would leave the guest without a garage);
 * - the generation is only asked when the year falls into two of them;
 * - changing the model or the year clears everything below it;
 * - from the year on, the car can be saved as it is — make and model are
 *   the minimum.
 *
 * Everything is a plain function of its inputs, so the rules are tested
 * without React Native (`car-picker.test.ts`).
 */

export type CarStep = CarLevel;

/** Which answer of the server a step needs before it can be shown. */
export type PickerDataKey = "makes" | "models" | "generations" | "modifications";

export interface PickerOption {
  id: string;
  label: string;
  /** A second line: the years of a generation, the size of an engine. */
  hint?: string;
  /** Other spellings a search on the device matches («Джили»). */
  aliases?: string[];
}

export type PickerStage =
  | { kind: "load"; data: PickerDataKey }
  | { kind: "auto"; step: CarStep; option: PickerOption }
  | { kind: "choose"; step: CarStep; options: PickerOption[] }
  | { kind: "done" };

export interface PickerData {
  /** `null` — not loaded yet. */
  makes: VehicleNamed[] | null;
  models: VehicleNamed[] | null;
  generations: VehicleGenerationSummary[] | null;
  modifications: VehicleModificationView[] | null;
}

export const EMPTY_PICKER_DATA: PickerData = {
  makes: null,
  models: null,
  generations: null,
  modifications: null,
};

export interface CarDraft {
  make: CarLevelValue | null;
  model: CarLevelValue | null;
  year: number | null;
  generation: CarLevelValue | null;
  body: CarLevelValue | null;
  engine: CarLevelValue | null;
  transmission: CarLevelValue | null;
  drive: CarLevelValue | null;
}

export const EMPTY_DRAFT: CarDraft = {
  make: null,
  model: null,
  year: null,
  generation: null,
  body: null,
  engine: null,
  transmission: null,
  drive: null,
};

// ------------------------------------------------------------- options

function named(value: VehicleNamed): PickerOption {
  return { id: value.id, label: value.name, aliases: value.aliases };
}

/** «2016 — 2022», «2023 — {по настоящее время}». */
export function generationYears(generation: VehicleGenerationSummary, stillMade: string): string {
  return `${generation.yearFrom} — ${generation.yearTo ?? stillMade}`;
}

/**
 * The years of a model: every year covered by any of its generations,
 * newest first. A generation still made runs up to the current year.
 */
export function carYears(
  generations: readonly VehicleGenerationSummary[],
  currentYear: number,
): number[] {
  const years = new Set<number>();
  for (const generation of generations) {
    const to = Math.min(generation.yearTo ?? currentYear, currentYear);
    for (let year = generation.yearFrom; year <= to; year += 1) years.add(year);
  }
  return [...years].sort((a, b) => b - a);
}

/** The generations a year falls into — more than one means the step is asked. */
export function generationsForYear(
  generations: readonly VehicleGenerationSummary[],
  year: number | null,
): VehicleGenerationSummary[] {
  if (year === null) return [...generations];
  return generations.filter(
    (generation) => year >= generation.yearFrom && year <= (generation.yearTo ?? Infinity),
  );
}

function engineLabel(modification: VehicleModificationView): string {
  return modification.engine.code;
}

function engineHint(modification: VehicleModificationView): string | undefined {
  const { displacementL, powerHp, fuel } = modification.engine;
  const parts = [
    displacementL !== null ? `${displacementL} л` : null,
    powerHp !== null ? `${powerHp} л. с.` : null,
    fuel.name.text,
  ].filter((part): part is string => part !== null && part !== "");
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export function coversYear(modification: VehicleModificationView, year: number): boolean {
  return year >= modification.yearFrom && year <= (modification.yearTo ?? Infinity);
}

function distinct(options: PickerOption[]): PickerOption[] {
  const seen = new Set<string>();
  return options.filter((option) => {
    if (seen.has(option.id)) return false;
    seen.add(option.id);
    return true;
  });
}

/**
 * The modifications still possible for the draft: those of the year (when
 * the catalog has any for it) and of every level already chosen. A year no
 * modification covers is ignored rather than emptying the list — the
 * vehicle catalog is filled in by hand and is incomplete in places.
 */
export function narrowModifications(
  modifications: readonly VehicleModificationView[],
  draft: CarDraft,
): VehicleModificationView[] {
  let rows = [...modifications];
  if (draft.year !== null) {
    const year = draft.year;
    const ofYear = rows.filter((row) => coversYear(row, year));
    if (ofYear.length > 0) rows = ofYear;
  }
  if (draft.body) rows = rows.filter((row) => row.bodyType.id === draft.body?.id);
  if (draft.engine) rows = rows.filter((row) => row.engine.id === draft.engine?.id);
  if (draft.transmission) {
    rows = rows.filter((row) => row.transmissionType.id === draft.transmission?.id);
  }
  if (draft.drive) rows = rows.filter((row) => row.driveType.id === draft.drive?.id);
  return rows;
}

function modificationOptions(
  rows: readonly VehicleModificationView[],
  step: "body" | "engine" | "transmission" | "drive",
): PickerOption[] {
  switch (step) {
    case "body":
      return distinct(rows.map((row) => ({ id: row.bodyType.id, label: row.bodyType.name.text })));
    case "engine":
      return distinct(
        rows.map((row) => ({
          id: row.engine.id,
          label: engineLabel(row),
          hint: engineHint(row),
        })),
      );
    case "transmission":
      return distinct(
        rows.map((row) => ({ id: row.transmissionType.id, label: row.transmissionType.name.text })),
      );
    default:
      return distinct(
        rows.map((row) => ({ id: row.driveType.id, label: row.driveType.name.text })),
      );
  }
}

// --------------------------------------------------------------- steps

export interface StageInput {
  draft: CarDraft;
  data: PickerData;
  currentYear: number;
  /** The word for a generation that is still made, in the interface language. */
  stillMade: string;
}

/**
 * What the screen must do next: load an answer of the server, take the only
 * option of a step, ask the user, or stop — nothing is left to ask.
 */
export function pickerStage({ draft, data, currentYear, stillMade }: StageInput): PickerStage {
  if (!draft.make) {
    if (data.makes === null) return { kind: "load", data: "makes" };
    return offer("make", data.makes.map(named));
  }
  if (!draft.model) {
    if (data.models === null) return { kind: "load", data: "models" };
    return offer("model", data.models.map(named));
  }

  const needsGenerations = draft.year === null || draft.generation === null;
  if (needsGenerations && data.generations === null) return { kind: "load", data: "generations" };
  const generations = data.generations ?? [];

  if (draft.year === null) {
    const years = carYears(generations, currentYear);
    const stage = offer(
      "year",
      years.map((year) => ({ id: String(year), label: String(year) })),
    );
    if (stage.kind !== "done") return stage;
  }
  if (!draft.generation) {
    const candidates = generationsForYear(generations, draft.year);
    const stage = offer(
      "generation",
      candidates.map((generation) => ({
        id: generation.id,
        label: generation.name,
        hint: generationYears(generation, stillMade),
      })),
    );
    if (stage.kind !== "done") return stage;
  }

  // Body, engine, transmission and drive all come from the modifications of
  // the chosen generation: without one there is nothing left to ask.
  if (!draft.generation) return { kind: "done" };
  if (data.modifications === null) return { kind: "load", data: "modifications" };

  for (const step of ["body", "engine", "transmission", "drive"] as const) {
    if (draft[step]) continue;
    const rows = narrowModifications(data.modifications, draft);
    const stage = offer(step, modificationOptions(rows, step));
    if (stage.kind !== "done") return stage;
  }
  return { kind: "done" };
}

/**
 * The stage after every step that has a single option has been taken. The
 * screen works with this: auto-selection is a pure consequence of the data,
 * not something a component has to remember to do.
 */
export function resolveStage(input: StageInput): { draft: CarDraft; stage: PickerStage } {
  let draft = input.draft;
  // Each round fills one level, so the walk cannot run longer than the levels.
  for (let round = 0; round <= CAR_LEVELS.length; round += 1) {
    const stage = pickerStage({ ...input, draft });
    if (stage.kind !== "auto") return { draft, stage };
    draft = applyOption(draft, stage.step, stage.option);
  }
  return { draft, stage: { kind: "done" } };
}

/** One option is taken by itself, none skips the step, more than one is asked. */
function offer(step: CarStep, options: PickerOption[]): PickerStage {
  if (options.length === 0) return { kind: "done" };
  if (options.length === 1 && options[0]) return { kind: "auto", step, option: options[0] };
  return { kind: "choose", step, options };
}

/** The levels below `step`, in the order they are asked. */
export function levelsBelow(step: CarStep): CarLevel[] {
  return CAR_LEVELS.slice(CAR_LEVELS.indexOf(step) + 1);
}

/** Which of the levels below `step` currently hold a value — the warning of M-GAR-03. */
export function levelsClearedBy(draft: CarDraft, step: CarStep): CarLevel[] {
  return levelsBelow(step).filter((level) =>
    level === "year" ? draft.year !== null : draft[level] !== null,
  );
}

export function resetBelow(draft: CarDraft, step: CarStep): CarDraft {
  const next = { ...draft };
  for (const level of levelsBelow(step)) {
    if (level === "year") next.year = null;
    else next[level] = null;
  }
  return next;
}

/** Takes an option of a step and clears everything below it. */
export function applyOption(draft: CarDraft, step: CarStep, option: PickerOption): CarDraft {
  const next = resetBelow(draft, step);
  if (step === "year") {
    next.year = Number(option.id);
    return next;
  }
  next[step] = { id: option.id, label: option.label };
  return next;
}

/** Clears a step and everything below it («Дополнить» returns to the empty one). */
export function clearFrom(draft: CarDraft, step: CarStep): CarDraft {
  const next = resetBelow(draft, step);
  if (step === "year") next.year = null;
  else next[step] = null;
  return next;
}

/** The chosen values shown above a step; tapping one returns to that step. */
export function chosenLevels(draft: CarDraft): { level: CarLevel; label: string }[] {
  const chosen: { level: CarLevel; label: string }[] = [];
  for (const level of CAR_LEVELS) {
    if (level === "year") {
      if (draft.year !== null) chosen.push({ level, label: String(draft.year) });
      continue;
    }
    const value = draft[level];
    if (value) chosen.push({ level, label: value.label });
  }
  return chosen;
}

/** «Сохранить так» appears once make and model are known (from the year step). */
export function canSaveDraft(draft: CarDraft): boolean {
  return draft.make !== null && draft.model !== null;
}

/**
 * The car to store. `modificationId` is set only when the chosen levels
 * name exactly one modification — then the catalog can send the whole
 * modification instead of the separate levels.
 */
export function draftToCar(
  draft: CarDraft,
  options: { id: string; addedAt: string; modifications: readonly VehicleModificationView[] },
): GarageCar | null {
  if (!draft.make || !draft.model) return null;
  const rows = narrowModifications(options.modifications, draft);
  const only = rows.length === 1 && draft.generation ? rows[0] : undefined;
  // The year must lie inside the modification's years, or the server refuses
  // the car as inconsistent (`year_outside`): `narrowModifications` ignores a
  // year the catalog has no modification for, and that must not leak here.
  const single = only && (draft.year === null || coversYear(only, draft.year)) ? only : undefined;
  return {
    id: options.id,
    make: draft.make,
    model: draft.model,
    year: draft.year,
    generation: draft.generation,
    body: draft.body,
    engine: draft.engine,
    transmission: draft.transmission,
    drive: draft.drive,
    modificationId: single?.id ?? null,
    addedAt: options.addedAt,
  };
}

/** A stored car back as a draft — «Дополнить» and editing start from it. */
export function carToDraft(car: GarageCar): CarDraft {
  return {
    make: car.make,
    model: car.model,
    year: car.year,
    generation: car.generation,
    body: car.body,
    engine: car.engine,
    transmission: car.transmission,
    drive: car.drive,
  };
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ").replace(/ё/g, "е");
}

/** Search inside a step: by the label and by the other spellings of the catalog. */
export function filterOptions(options: readonly PickerOption[], query: string): PickerOption[] {
  const search = normalize(query);
  if (search === "") return [...options];
  return options.filter(
    (option) =>
      normalize(option.label).includes(search) ||
      (option.aliases ?? []).some((alias) => normalize(alias).includes(search)),
  );
}
