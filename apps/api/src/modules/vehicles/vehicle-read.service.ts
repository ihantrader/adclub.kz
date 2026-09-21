import { Inject, Injectable } from "@nestjs/common";
import type {
  CatalogLanguage,
  LocalizedText,
  VehicleGenerationSummary,
  VehicleGenerationsResponse,
  VehicleMakesResponse,
  VehicleMarket,
  VehicleModelsResponse,
  VehicleModificationsResponse,
  VehicleNamed,
  VehicleOptionView,
} from "@adclub/contracts";
import { and, desc, eq, inArray } from "drizzle-orm";
import { DatabaseService } from "../../database";
import { decimal } from "./vehicle-common";
import { notFound } from "./vehicle-errors";
import { makeSpellings, modelSpellings } from "./vehicle-hierarchy.service";
import { engineSpellings, optionsById } from "./vehicle-modifications.service";
import {
  vehicleEngine,
  vehicleGeneration,
  vehicleMake,
  vehicleModel,
  vehicleModification,
  type VehicleGenerationRow,
  type VehicleMakeRow,
  type VehicleModelRow,
  type VehicleOptionRow,
} from "./schema";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The name in the language asked for; without it — the Russian one, marked as a fallback. */
function localizedName(row: VehicleOptionRow, lang: CatalogLanguage): LocalizedText {
  const own = lang === "kk" ? row.nameKk : lang === "en" ? row.nameEn : row.nameRu;
  return own === null
    ? { text: row.nameRu, isFallback: lang !== "ru" }
    : { text: own, isFallback: false };
}

function optionView(row: VehicleOptionRow, lang: CatalogLanguage): VehicleOptionView {
  return { id: row.id, code: row.code, name: localizedName(row, lang) };
}

function generationSummary(row: VehicleGenerationRow): VehicleGenerationSummary {
  return { id: row.id, name: row.name, yearFrom: row.yearFrom, yearTo: row.yearTo };
}

/**
 * The vehicle catalog for clients (TASK-014 requirement 4; SCREENS
 * M-GAR-03): makes → models → generations → modifications, step by step,
 * only what is active and under active parents. Proper names are as
 * written; the names of the reference lists are in the language of the
 * request with the Russian one as the fallback. Missing, archived and
 * malformed — the same 404. Read from the database on every request.
 */
@Injectable()
export class VehicleReadService {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async makes(lang: CatalogLanguage): Promise<VehicleMakesResponse> {
    const rows = await this.database.db
      .select()
      .from(vehicleMake)
      .where(eq(vehicleMake.status, "active"));
    const spellings = await makeSpellings(
      this.database.db,
      rows.map((row) => row.id),
    );
    const makes = rows
      .map((row) => ({ row, spelling: spellings.get(row.id)! }))
      .sort((a, b) => a.spelling.key.localeCompare(b.spelling.key))
      .map(({ row, spelling }) => ({ id: row.id, name: spelling.name, aliases: spelling.aliases }));
    return { language: lang, makes };
  }

  async models(makeId: string, lang: CatalogLanguage): Promise<VehicleModelsResponse> {
    const make = await this.activeMake(makeId);
    const rows = await this.database.db
      .select()
      .from(vehicleModel)
      .where(and(eq(vehicleModel.makeId, make.id), eq(vehicleModel.status, "active")));
    return {
      language: lang,
      make: await this.namedMake(make),
      models: await this.namedModels(rows),
    };
  }

  async generations(modelId: string, lang: CatalogLanguage): Promise<VehicleGenerationsResponse> {
    const { make, model } = await this.activeModel(modelId);
    const rows = await this.database.db
      .select()
      .from(vehicleGeneration)
      .where(and(eq(vehicleGeneration.modelId, model.id), eq(vehicleGeneration.status, "active")))
      .orderBy(desc(vehicleGeneration.yearFrom), vehicleGeneration.nameKey);
    return {
      language: lang,
      make: await this.namedMake(make),
      model: (await this.namedModels([model]))[0]!,
      generations: rows.map(generationSummary),
    };
  }

  async modifications(
    generationId: string,
    lang: CatalogLanguage,
    market: VehicleMarket | undefined,
  ): Promise<VehicleModificationsResponse> {
    if (!UUID.test(generationId)) {
      throw notFound("generation");
    }
    const [generation] = await this.database.db
      .select()
      .from(vehicleGeneration)
      .where(eq(vehicleGeneration.id, generationId));
    if (!generation || generation.status !== "active") {
      throw notFound("generation");
    }
    const { make, model } = await this.activeModel(generation.modelId, "generation");
    const rows = await this.database.db
      .select()
      .from(vehicleModification)
      .where(
        and(
          eq(vehicleModification.generationId, generation.id),
          eq(vehicleModification.status, "active"),
          market ? eq(vehicleModification.market, market) : undefined,
        ),
      )
      .orderBy(desc(vehicleModification.yearFrom), vehicleModification.id);
    // Kazakhstan configurations first (PRODUCT 7.7), then by year, newest first.
    rows.sort((a, b) => Number(b.market === "kz") - Number(a.market === "kz"));
    const engineIds = [...new Set(rows.map((row) => row.engineId))];
    const engines =
      engineIds.length === 0
        ? []
        : await this.database.db
            .select()
            .from(vehicleEngine)
            .where(inArray(vehicleEngine.id, engineIds));
    const [codes, options] = await Promise.all([
      engineSpellings(this.database.db, engineIds),
      optionsById(this.database.db, [
        ...rows.flatMap((row) => [row.bodyTypeId, row.transmissionTypeId, row.driveTypeId]),
        ...engines.map((engine) => engine.fuelId),
      ]),
    ]);
    const engineById = new Map(engines.map((engine) => [engine.id, engine]));
    return {
      language: lang,
      make: await this.namedMake(make),
      model: (await this.namedModels([model]))[0]!,
      generation: generationSummary(generation),
      modifications: rows.map((row) => {
        const engine = engineById.get(row.engineId)!;
        return {
          id: row.id,
          bodyType: optionView(options.get(row.bodyTypeId)!, lang),
          engine: {
            id: engine.id,
            code: codes.get(engine.id)?.code ?? "",
            displacementL: decimal(engine.displacementL),
            powerHp: engine.powerHp,
            fuel: optionView(options.get(engine.fuelId)!, lang),
          },
          transmissionType: optionView(options.get(row.transmissionTypeId)!, lang),
          driveType: optionView(options.get(row.driveTypeId)!, lang),
          yearFrom: row.yearFrom,
          yearTo: row.yearTo,
          market: row.market,
        };
      }),
    };
  }

  private async activeMake(makeId: string, what = "make"): Promise<VehicleMakeRow> {
    if (!UUID.test(makeId)) {
      throw notFound(what);
    }
    const [row] = await this.database.db
      .select()
      .from(vehicleMake)
      .where(eq(vehicleMake.id, makeId));
    if (!row || row.status !== "active") {
      throw notFound(what);
    }
    return row;
  }

  /** The model is active and so is its make. */
  private async activeModel(
    modelId: string,
    what = "model",
  ): Promise<{ make: VehicleMakeRow; model: VehicleModelRow }> {
    if (!UUID.test(modelId)) {
      throw notFound(what);
    }
    const [model] = await this.database.db
      .select()
      .from(vehicleModel)
      .where(eq(vehicleModel.id, modelId));
    if (!model || model.status !== "active") {
      throw notFound(what);
    }
    return { make: await this.activeMake(model.makeId, what), model };
  }

  private async namedMake(make: VehicleMakeRow): Promise<VehicleNamed> {
    const spelling = (await makeSpellings(this.database.db, [make.id])).get(make.id)!;
    return { id: make.id, name: spelling.name, aliases: spelling.aliases };
  }

  private async namedModels(rows: readonly VehicleModelRow[]): Promise<VehicleNamed[]> {
    const spellings = await modelSpellings(
      this.database.db,
      rows.map((row) => row.id),
    );
    return rows
      .map((row) => ({ row, spelling: spellings.get(row.id)! }))
      .sort((a, b) => a.spelling.key.localeCompare(b.spelling.key))
      .map(({ row, spelling }) => ({ id: row.id, name: spelling.name, aliases: spelling.aliases }));
  }
}
