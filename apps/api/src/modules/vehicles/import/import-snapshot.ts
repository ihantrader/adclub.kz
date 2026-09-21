import { inArray } from "drizzle-orm";
import type { DbExecutor } from "../../../database";
import { decimal, nameKey, spellingKey } from "../vehicle-common";
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
} from "../schema";
import {
  emptySnapshot,
  generationKey,
  identityKey,
  modelKey,
  type ImportSnapshot,
  type RowValues,
} from "./import-plan";

/** How many generation ids one query of modifications names at most. */
const IN_CHUNK = 1000;

/**
 * The catalog as import rows are checked against (ARCHITECTURE 4.24):
 * every option, make, model, generation and engine — these lists are small
 * — and the modifications of the existing generations the rows name.
 * Read in the caller's transaction; the apply reads it under the vehicle
 * lock, so nothing changes under it.
 */
export async function loadSnapshot(
  executor: DbExecutor,
  rows: readonly (RowValues | null)[],
): Promise<ImportSnapshot> {
  const snapshot = emptySnapshot();
  const [options, makes, makeNames, models, modelNames, generations, engines, engineNames] =
    await Promise.all([
      executor.select().from(vehicleOption),
      executor.select().from(vehicleMake),
      executor.select().from(vehicleMakeSpelling),
      executor.select().from(vehicleModel),
      executor.select().from(vehicleModelSpelling),
      executor.select().from(vehicleGeneration),
      executor.select().from(vehicleEngine),
      executor.select().from(vehicleEngineSpelling),
    ]);
  for (const option of options) {
    const byName = snapshot.options.get(option.kind)!;
    const entry = { id: option.id, status: option.status };
    for (const name of [option.nameRu, option.nameKk, option.nameEn]) {
      if (name !== null) {
        byName.set(nameKey(name), entry);
      }
    }
    // A code wins over a name that happens to spell the same.
    byName.set(nameKey(option.code), entry);
  }
  const makeStatus = new Map(makes.map((row) => [row.id, row.status]));
  for (const spelling of makeNames) {
    snapshot.makes.set(spelling.key, {
      id: spelling.makeId,
      status: makeStatus.get(spelling.makeId)!,
    });
  }
  const modelStatus = new Map(models.map((row) => [row.id, row.status]));
  for (const spelling of modelNames) {
    snapshot.models.set(`${spelling.makeId}|${spelling.key}`, {
      id: spelling.modelId,
      status: modelStatus.get(spelling.modelId)!,
    });
  }
  for (const generation of generations) {
    snapshot.generations.set(`${generation.modelId}|${generation.nameKey}`, {
      id: generation.id,
      status: generation.status,
      yearFrom: generation.yearFrom,
      yearTo: generation.yearTo,
    });
  }
  const engineById = new Map(engines.map((row) => [row.id, row]));
  for (const spelling of engineNames) {
    const engine = engineById.get(spelling.engineId)!;
    snapshot.engines.set(spelling.key, {
      id: engine.id,
      status: engine.status,
      fuelId: engine.fuelId,
      displacementL: decimal(engine.displacementL),
      powerHp: engine.powerHp,
    });
  }

  // The existing generations the rows name: only their modifications matter.
  const generationIds = new Set<string>();
  for (const values of rows) {
    if (!values?.make || !values.model || !values.generation) {
      continue;
    }
    const make = snapshot.makes.get(spellingKey(values.make));
    const model = make ? snapshot.models.get(modelKey(make.id, values.model)) : undefined;
    const generation = model
      ? snapshot.generations.get(generationKey(model.id, values.generation))
      : undefined;
    if (generation) {
      generationIds.add(generation.id);
    }
  }
  const ids = [...generationIds];
  for (let at = 0; at < ids.length; at += IN_CHUNK) {
    const modifications = await executor
      .select()
      .from(vehicleModification)
      .where(inArray(vehicleModification.generationId, ids.slice(at, at + IN_CHUNK)));
    for (const modification of modifications) {
      snapshot.modifications.set(identityKey(modification), {
        id: modification.id,
        status: modification.status,
        market: modification.market,
      });
    }
  }
  return snapshot;
}
