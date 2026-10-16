import type { VehicleGenerationSummary, VehicleNamed } from "@adclub/contracts";
import type { Choice } from "@adclub/ui";
import { apiClient } from "../api";

/**
 * The vehicle catalog as the cabinet chooses from it (S-OFF-04 prices by
 * model, S-OFF-07 compatibility): the public lists clients choose their car
 * from (`/vehicles/…`), each loaded once per page; a field searches them on
 * the device by any spelling («джили» → Geely), as the garage of the app does.
 */
let makes: Promise<VehicleNamed[]> | null = null;
const models = new Map<string, Promise<VehicleNamed[]>>();
const generations = new Map<string, Promise<VehicleGenerationSummary[]>>();
const engines = new Map<string, Promise<VehicleNamed[]>>();

/** One request per key at a time; a failed one is asked again next time. */
function once<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  let found = cache.get(key);
  if (!found) {
    found = load().catch((error: unknown) => {
      cache.delete(key);
      throw error;
    });
    cache.set(key, found);
  }
  return found;
}

export function loadMakes(): Promise<VehicleNamed[]> {
  makes ??= apiClient.getVehicleMakes().then(
    (answer) => answer.makes,
    (error: unknown) => {
      makes = null;
      throw error;
    },
  );
  return makes;
}

export function loadModels(makeId: string): Promise<VehicleNamed[]> {
  return once(models, makeId, () =>
    apiClient.getVehicleMakeModels({ makeId }).then((answer) => answer.models),
  );
}

export function loadGenerations(modelId: string): Promise<VehicleGenerationSummary[]> {
  return once(generations, modelId, () =>
    apiClient.getVehicleModelGenerations({ modelId }).then((answer) => answer.generations),
  );
}

/** The engines of a generation: those of its modifications, each once, by code. */
export function loadEngines(generationId: string): Promise<VehicleNamed[]> {
  return once(engines, generationId, () =>
    apiClient.getVehicleGenerationModifications({ generationId }).then((answer) => {
      const byId = new Map<string, VehicleNamed>();
      for (const modification of answer.modifications) {
        const engine = modification.engine;
        const volume =
          engine.displacementL === null ? null : `${engine.displacementL.toFixed(1)} л`;
        byId.set(engine.id, {
          id: engine.id,
          name: [engine.code, volume].filter(Boolean).join(" · "),
          aliases: [],
        });
      }
      return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
    }),
  );
}

/** A generation's name with its years: «II (FX11) · 2023–н. в.». */
export function generationNamed(generation: VehicleGenerationSummary, now: string): VehicleNamed {
  return {
    id: generation.id,
    name: `${generation.name} · ${generation.yearFrom}–${generation.yearTo ?? now}`,
    aliases: [],
  };
}

/** The entries whose name or another spelling has the query in it, as choices. */
export function searchNamed(list: readonly VehicleNamed[], query: string): Choice[] {
  const wanted = query.trim().toLowerCase();
  return list
    .filter(
      (entry) =>
        wanted === "" ||
        [entry.name, ...entry.aliases].some((name) => name.toLowerCase().includes(wanted)),
    )
    .slice(0, 50)
    .map((entry) => ({
      id: entry.id,
      label: entry.name,
      note: entry.aliases.length > 0 ? entry.aliases.join(", ") : null,
    }));
}
