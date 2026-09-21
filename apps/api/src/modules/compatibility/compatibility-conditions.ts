import type {
  CompatibilityConditions,
  CompatibilityConditionsInput,
  CompatibilityConditionsLabel,
  CompatibilityVehicle,
  ResolvedCompatibilityVehicle,
  VehicleOptionKind,
} from "@adclub/contracts";
import { and, eq, inArray } from "drizzle-orm";
import type { DbExecutor } from "../../database";
import {
  vehicleEngine,
  vehicleEngineSpelling,
  vehicleGeneration,
  vehicleMake,
  vehicleMakeSpelling,
  vehicleModel,
  vehicleModelSpelling,
  vehicleModification,
  vehicleOption,
} from "../vehicles";
import { conditionsInvalid, vehicleInvalid } from "./compatibility-errors";

/**
 * The levels of a record, a proposal and a car checked against the vehicle
 * catalog (ARCHITECTURE 4.25). Archived rows are accepted everywhere: a
 * part for an old car is still a part for it, and a car a user chose
 * before its archiving keeps its result (TASK-015 requirement 1).
 */

type OptionField = "bodyTypeId" | "transmissionTypeId" | "driveTypeId";

const OPTION_FIELDS: readonly (readonly [OptionField, VehicleOptionKind])[] = [
  ["bodyTypeId", "body"],
  ["transmissionTypeId", "transmission"],
  ["driveTypeId", "drive"],
];

interface GenerationRow {
  id: string;
  modelId: string;
  yearFrom: number;
  yearTo: number | null;
}

async function makeExists(executor: DbExecutor, id: string): Promise<boolean> {
  const [row] = await executor
    .select({ id: vehicleMake.id })
    .from(vehicleMake)
    .where(eq(vehicleMake.id, id));
  return Boolean(row);
}

async function modelOf(executor: DbExecutor, id: string) {
  const [row] = await executor
    .select({ id: vehicleModel.id, makeId: vehicleModel.makeId })
    .from(vehicleModel)
    .where(eq(vehicleModel.id, id));
  return row ?? null;
}

async function generationOf(executor: DbExecutor, id: string): Promise<GenerationRow | null> {
  const [row] = await executor
    .select({
      id: vehicleGeneration.id,
      modelId: vehicleGeneration.modelId,
      yearFrom: vehicleGeneration.yearFrom,
      yearTo: vehicleGeneration.yearTo,
    })
    .from(vehicleGeneration)
    .where(eq(vehicleGeneration.id, id));
  return row ?? null;
}

async function optionExists(
  executor: DbExecutor,
  id: string,
  kind: VehicleOptionKind,
): Promise<boolean> {
  const [row] = await executor
    .select({ id: vehicleOption.id })
    .from(vehicleOption)
    .where(and(eq(vehicleOption.id, id), eq(vehicleOption.kind, kind)));
  return Boolean(row);
}

async function engineExists(executor: DbExecutor, id: string): Promise<boolean> {
  const [row] = await executor
    .select({ id: vehicleEngine.id })
    .from(vehicleEngine)
    .where(eq(vehicleEngine.id, id));
  return Boolean(row);
}

function within(year: number, from: number, to: number | null): boolean {
  return year >= from && (to === null || year <= to);
}

/**
 * The conditions of a record or a proposal, whole and agreeing with the
 * vehicle catalog: the model of a generation is filled in when left out
 * (and must be the generation's when given), the model must be of the
 * make, options of their list, years in order and within the generation.
 */
export async function resolveConditions(
  executor: DbExecutor,
  input: CompatibilityConditionsInput,
): Promise<CompatibilityConditions> {
  const conditions: CompatibilityConditions = {
    makeId: input.makeId,
    modelId: input.modelId ?? null,
    generationId: input.generationId ?? null,
    bodyTypeId: input.bodyTypeId ?? null,
    engineId: input.engineId ?? null,
    transmissionTypeId: input.transmissionTypeId ?? null,
    driveTypeId: input.driveTypeId ?? null,
    yearFrom: input.yearFrom ?? null,
    yearTo: input.yearTo ?? null,
  };
  if (!(await makeExists(executor, conditions.makeId))) {
    throw conditionsInvalid("not_found", "makeId");
  }
  let generation: GenerationRow | null = null;
  if (conditions.generationId) {
    generation = await generationOf(executor, conditions.generationId);
    if (!generation) {
      throw conditionsInvalid("not_found", "generationId");
    }
    if (conditions.modelId && conditions.modelId !== generation.modelId) {
      throw conditionsInvalid("generation_of_other_model", "generationId");
    }
    conditions.modelId = generation.modelId;
  }
  if (conditions.modelId) {
    const model = await modelOf(executor, conditions.modelId);
    if (!model) {
      throw conditionsInvalid("not_found", "modelId");
    }
    if (model.makeId !== conditions.makeId) {
      throw conditionsInvalid("model_of_other_make", "modelId");
    }
  }
  for (const [field, kind] of OPTION_FIELDS) {
    const id = conditions[field];
    if (id && !(await optionExists(executor, id, kind))) {
      throw conditionsInvalid("not_found", field);
    }
  }
  if (conditions.engineId && !(await engineExists(executor, conditions.engineId))) {
    throw conditionsInvalid("not_found", "engineId");
  }
  const { yearFrom, yearTo } = conditions;
  if (yearFrom !== null && yearTo !== null && yearTo < yearFrom) {
    throw conditionsInvalid("years_order", "yearTo");
  }
  if (generation) {
    for (const [field, year] of [
      ["yearFrom", yearFrom],
      ["yearTo", yearTo],
    ] as const) {
      if (year !== null && !within(year, generation.yearFrom, generation.yearTo)) {
        throw conditionsInvalid("years_outside_generation", field);
      }
    }
  }
  return conditions;
}

/** Whether two sets of conditions name the same cars. */
export function sameConditions(a: CompatibilityConditions, b: CompatibilityConditions): boolean {
  return (
    a.makeId === b.makeId &&
    a.modelId === b.modelId &&
    a.generationId === b.generationId &&
    a.bodyTypeId === b.bodyTypeId &&
    a.engineId === b.engineId &&
    a.transmissionTypeId === b.transmissionTypeId &&
    a.driveTypeId === b.driveTypeId &&
    a.yearFrom === b.yearFrom &&
    a.yearTo === b.yearTo
  );
}

/** The conditions of a stored row. */
export function conditionsOf(row: CompatibilityConditions): CompatibilityConditions {
  return {
    makeId: row.makeId,
    modelId: row.modelId,
    generationId: row.generationId,
    bodyTypeId: row.bodyTypeId,
    engineId: row.engineId,
    transmissionTypeId: row.transmissionTypeId,
    driveTypeId: row.driveTypeId,
    yearFrom: row.yearFrom,
    yearTo: row.yearTo,
  };
}

/**
 * A car of a check as the server understands it (TASK-015 requirement 5):
 * the levels implied by a known one are taken from the catalog; a level
 * given together with one that implies it must agree with it. The years
 * the car can be of are its year, else the modification's, else the
 * generation's; unknown otherwise.
 */
export async function resolveVehicle(
  executor: DbExecutor,
  input: CompatibilityVehicle,
): Promise<ResolvedCompatibilityVehicle> {
  const car = {
    modificationId: null as string | null,
    makeId: null as string | null,
    modelId: null as string | null,
    generationId: null as string | null,
    bodyTypeId: null as string | null,
    engineId: null as string | null,
    transmissionTypeId: null as string | null,
    driveTypeId: null as string | null,
  };
  let years: { from: number; to: number | null } | null = null;
  let modificationYears: { from: number; to: number | null } | null = null;
  let generationYears: { from: number; to: number | null } | null = null;

  if (input.modificationId) {
    const [row] = await executor
      .select()
      .from(vehicleModification)
      .where(eq(vehicleModification.id, input.modificationId));
    if (!row) {
      throw vehicleInvalid("not_found", "modificationId");
    }
    car.modificationId = row.id;
    car.generationId = row.generationId;
    car.bodyTypeId = row.bodyTypeId;
    car.engineId = row.engineId;
    car.transmissionTypeId = row.transmissionTypeId;
    car.driveTypeId = row.driveTypeId;
    modificationYears = { from: row.yearFrom, to: row.yearTo };
  }
  const fromModification = (field: keyof typeof car) =>
    car.modificationId !== null && car[field] !== null;

  if (input.generationId) {
    if (fromModification("generationId") && car.generationId !== input.generationId) {
      throw vehicleInvalid("modification_mismatch", "generationId");
    }
    car.generationId = input.generationId;
  }
  if (car.generationId) {
    const generation = await generationOf(executor, car.generationId);
    if (!generation) {
      throw vehicleInvalid("not_found", "generationId");
    }
    car.modelId = generation.modelId;
    generationYears = { from: generation.yearFrom, to: generation.yearTo };
  }
  if (input.modelId) {
    if (car.modelId !== null && car.modelId !== input.modelId) {
      throw car.modificationId
        ? vehicleInvalid("modification_mismatch", "modelId")
        : vehicleInvalid("generation_of_other_model", "generationId");
    }
    car.modelId = input.modelId;
  }
  if (car.modelId) {
    const model = await modelOf(executor, car.modelId);
    if (!model) {
      throw vehicleInvalid("not_found", "modelId");
    }
    car.makeId = model.makeId;
  }
  if (input.makeId) {
    if (car.makeId !== null && car.makeId !== input.makeId) {
      throw car.modificationId
        ? vehicleInvalid("modification_mismatch", "makeId")
        : vehicleInvalid("model_of_other_make", "modelId");
    }
    if (!(await makeExists(executor, input.makeId))) {
      throw vehicleInvalid("not_found", "makeId");
    }
    car.makeId = input.makeId;
  }
  for (const [field, kind] of OPTION_FIELDS) {
    const given = input[field];
    if (!given) {
      continue;
    }
    if (fromModification(field) && car[field] !== given) {
      throw vehicleInvalid("modification_mismatch", field);
    }
    if (!(await optionExists(executor, given, kind))) {
      throw vehicleInvalid("not_found", field);
    }
    car[field] = given;
  }
  if (input.engineId) {
    if (fromModification("engineId") && car.engineId !== input.engineId) {
      throw vehicleInvalid("modification_mismatch", "engineId");
    }
    if (!(await engineExists(executor, input.engineId))) {
      throw vehicleInvalid("not_found", "engineId");
    }
    car.engineId = input.engineId;
  }
  if (!car.makeId) {
    throw vehicleInvalid("make_required", "makeId");
  }
  const known = modificationYears ?? generationYears;
  if (input.year !== undefined) {
    for (const range of [modificationYears, generationYears]) {
      if (range && !within(input.year, range.from, range.to)) {
        throw vehicleInvalid("year_outside", "year");
      }
    }
    years = { from: input.year, to: input.year };
  } else if (known) {
    years = known;
  }
  return {
    ...car,
    makeId: car.makeId,
    year: input.year ?? null,
    yearFrom: years?.from ?? null,
    yearTo: years?.to ?? null,
  };
}

function yearsLabel(from: number | null, to: number | null): string | null {
  if (from !== null && to !== null) {
    return from === to ? String(from) : `${String(from)}–${String(to)}`;
  }
  if (from !== null) {
    return `с ${String(from)}`;
  }
  if (to !== null) {
    return `по ${String(to)}`;
  }
  return null;
}

/**
 * The conditions in words (names as written, the Russian names of the
 * reference lists), for many rows at once — a handful of queries whatever
 * their number.
 */
export async function describeConditions(
  executor: DbExecutor,
  rows: readonly CompatibilityConditions[],
): Promise<CompatibilityConditionsLabel[]> {
  const ids = (pick: (row: CompatibilityConditions) => string | null) => [
    ...new Set(rows.map(pick).filter((id): id is string => id !== null)),
  ];
  const makeIds = ids((row) => row.makeId);
  const modelIds = ids((row) => row.modelId);
  const generationIds = ids((row) => row.generationId);
  const engineIds = ids((row) => row.engineId);
  const optionIds = ids((row) => row.bodyTypeId)
    .concat(ids((row) => row.transmissionTypeId))
    .concat(ids((row) => row.driveTypeId));
  const [makes, models, generations, engines, options] = await Promise.all([
    makeIds.length === 0
      ? []
      : executor
          .select({ id: vehicleMakeSpelling.makeId, text: vehicleMakeSpelling.text })
          .from(vehicleMakeSpelling)
          .where(
            and(inArray(vehicleMakeSpelling.makeId, makeIds), eq(vehicleMakeSpelling.isName, true)),
          ),
    modelIds.length === 0
      ? []
      : executor
          .select({ id: vehicleModelSpelling.modelId, text: vehicleModelSpelling.text })
          .from(vehicleModelSpelling)
          .where(
            and(
              inArray(vehicleModelSpelling.modelId, modelIds),
              eq(vehicleModelSpelling.isName, true),
            ),
          ),
    generationIds.length === 0
      ? []
      : executor
          .select({
            id: vehicleGeneration.id,
            name: vehicleGeneration.name,
            yearFrom: vehicleGeneration.yearFrom,
            yearTo: vehicleGeneration.yearTo,
          })
          .from(vehicleGeneration)
          .where(inArray(vehicleGeneration.id, generationIds)),
    engineIds.length === 0
      ? []
      : executor
          .select({ id: vehicleEngineSpelling.engineId, text: vehicleEngineSpelling.text })
          .from(vehicleEngineSpelling)
          .where(
            and(
              inArray(vehicleEngineSpelling.engineId, engineIds),
              eq(vehicleEngineSpelling.isCode, true),
            ),
          ),
    optionIds.length === 0
      ? []
      : executor
          .select({ id: vehicleOption.id, text: vehicleOption.nameRu })
          .from(vehicleOption)
          .where(inArray(vehicleOption.id, optionIds)),
  ]);
  const byId = (list: readonly { id: string; text: string }[]) =>
    new Map(list.map((entry) => [entry.id, entry.text]));
  const makeNames = byId(makes);
  const modelNames = byId(models);
  const engineCodes = byId(engines);
  const optionNames = byId(options);
  const generationNames = new Map(
    generations.map((entry) => [
      entry.id,
      `${entry.name} (${yearsLabel(entry.yearFrom, entry.yearTo) ?? ""})`,
    ]),
  );
  const name = (map: Map<string, string>, id: string | null) =>
    id === null ? null : (map.get(id) ?? null);
  return rows.map((row) => ({
    make: makeNames.get(row.makeId) ?? "",
    model: name(modelNames, row.modelId),
    generation: name(generationNames, row.generationId),
    body: name(optionNames, row.bodyTypeId),
    engine: name(engineCodes, row.engineId),
    transmission: name(optionNames, row.transmissionTypeId),
    drive: name(optionNames, row.driveTypeId),
    years: yearsLabel(row.yearFrom, row.yearTo),
  }));
}
