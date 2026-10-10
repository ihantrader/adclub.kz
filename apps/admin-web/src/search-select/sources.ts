import type { ApiClient } from "@adclub/api-client";
import type {
  AdminBrand,
  AdminVehicleEngine,
  AdminVehicleGeneration,
  AdminVehicleMake,
  AdminVehicleModel,
  VehicleEntryStatus,
} from "@adclub/contracts";
import { SEARCH_PAGE, type Choice } from "./search-select-core";

/**
 * What a «выбор с поиском» finds: the server's own search of each list
 * (`q` — a part of any spelling, case and spaces ignored), one page of
 * `SEARCH_PAGE` entries, never the whole list (TASK-035.B: the selects of
 * TASK-035 took the first 100 and lost the rest). `""` — the first entries.
 */
export type ChoiceSource = (query: string) => Promise<Choice[]>;

const q = (query: string) => (query ? { q: query } : {});

/** «1,5 л · 177 л.с.» — what an engine is besides its code. */
export function engineSpecs(engine: {
  displacementL: number | null;
  powerHp: number | null;
}): string {
  return [
    engine.displacementL ? `${String(engine.displacementL).replace(".", ",")} л` : null,
    engine.powerHp ? `${engine.powerHp} л.с.` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** «2019–н.в.» */
export function yearsText(yearFrom: number, yearTo: number | null): string {
  return `${yearFrom}–${yearTo ?? "н.в."}`;
}

const archivedNote = (status: VehicleEntryStatus) => (status === "archived" ? "в архиве" : null);

const joined = (...parts: (string | null | undefined)[]) =>
  parts.filter((part) => part).join(" · ") || null;

export function makeChoice(make: AdminVehicleMake): Choice {
  return {
    id: make.id,
    label: make.name,
    note: joined(make.aliases.join(", "), archivedNote(make.status)),
    muted: make.status === "archived",
  };
}

export function modelChoice(model: AdminVehicleModel): Choice {
  return {
    id: model.id,
    label: model.name,
    note: joined(model.aliases.join(", "), archivedNote(model.status)),
    muted: model.status === "archived",
  };
}

export function generationChoice(generation: AdminVehicleGeneration): Choice {
  return {
    id: generation.id,
    label: `${generation.name} (${yearsText(generation.yearFrom, generation.yearTo)})`,
    note: archivedNote(generation.status),
    muted: generation.status === "archived",
  };
}

export function engineChoice(engine: AdminVehicleEngine): Choice {
  return {
    id: engine.id,
    label: engine.code,
    note: joined(
      engineSpecs(engine),
      engine.fuel.names.ru,
      engine.aliases.join(", "),
      archivedNote(engine.status),
    ),
    muted: engine.status === "archived",
  };
}

export function brandChoice(brand: AdminBrand): Choice {
  return {
    id: brand.id,
    label: brand.name,
    note: joined(brand.aliases.join(", "), brand.status === "archived" ? "в архиве" : null),
    muted: brand.status === "archived",
  };
}

/** The searches of the admin panel's long lists, over its API client. */
export function createChoiceSources(client: ApiClient) {
  return {
    makes:
      (status?: VehicleEntryStatus): ChoiceSource =>
      async (query) =>
        (
          await client.listVehicleMakes({ query: { ...q(query), status, limit: SEARCH_PAGE } })
        ).makes.map(makeChoice),
    /** Models of one make. */
    models:
      (makeId: string, status?: VehicleEntryStatus): ChoiceSource =>
      async (query) =>
        (
          await client.listVehicleModels({
            query: { ...q(query), makeId, status, limit: SEARCH_PAGE },
          })
        ).models.map(modelChoice),
    /** Generations of one model. */
    generations:
      (modelId: string, status?: VehicleEntryStatus): ChoiceSource =>
      async (query) =>
        (
          await client.listVehicleGenerations({
            query: { ...q(query), modelId, status, limit: SEARCH_PAGE },
          })
        ).generations.map(generationChoice),
    engines:
      (status?: VehicleEntryStatus): ChoiceSource =>
      async (query) =>
        (
          await client.listVehicleEngines({ query: { ...q(query), status, limit: SEARCH_PAGE } })
        ).engines.map(engineChoice),
    brands:
      (status?: "active" | "archived"): ChoiceSource =>
      async (query) =>
        (
          await client.listAdminBrands({ query: { ...q(query), status, limit: SEARCH_PAGE } })
        ).brands.map(brandChoice),
    /** Suppliers by a part of the name or the БИН (TASK-036.B: the filter of A-ORD-01). */
    suppliers: (): ChoiceSource => async (query) =>
      (await client.listSuppliers({ query: { ...q(query), limit: SEARCH_PAGE } })).suppliers.map(
        (supplier) => ({
          id: supplier.id,
          label: supplier.name,
          note: joined(supplier.city.names.ru, supplier.bin ? `БИН ${supplier.bin}` : null),
        }),
      ),
  };
}

export type ChoiceSources = ReturnType<typeof createChoiceSources>;
