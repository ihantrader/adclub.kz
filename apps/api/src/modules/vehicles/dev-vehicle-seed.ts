import { Inject, Injectable, Logger } from "@nestjs/common";
import type { VehicleMarket, VehicleOptionKind } from "@adclub/contracts";
import { and, eq, sql } from "drizzle-orm";
import { APP_CONFIG, type AppConfig } from "../../config";
import { DatabaseService } from "../../database";
import { nameKey, spellingKey, type VehicleActor } from "./vehicle-common";
import { VehicleHierarchyService } from "./vehicle-hierarchy.service";
import { VehicleModificationsService } from "./vehicle-modifications.service";
import { VehicleOptionsService } from "./vehicle-options.service";
import {
  vehicleEngineSpelling,
  vehicleGeneration,
  vehicleMakeSpelling,
  vehicleModelSpelling,
  vehicleModification,
  vehicleOption,
} from "./schema";

/**
 * A small vehicle catalog for development and tests (TASK-014 requirement
 * 5): the reference lists, Geely with several models, generations and
 * modifications of the Kazakhstan market, and one other make (Chery).
 *
 * The data is plausible but a DRAFT: it is not checked against official
 * sources (Geely Kazakhstan data is an external dependency of the Product
 * Owner), and the Kazakh names of the reference lists need a native
 * speaker (TASK-014-REPORT).
 */

interface OptionSeed {
  kind: VehicleOptionKind;
  code: string;
  names: { ru: string; kk: string; en: string };
}

export const devVehicleOptions: readonly OptionSeed[] = [
  { kind: "body", code: "sedan", names: { ru: "Седан", kk: "Седан", en: "Sedan" } },
  { kind: "body", code: "hatchback", names: { ru: "Хэтчбек", kk: "Хэтчбек", en: "Hatchback" } },
  { kind: "body", code: "liftback", names: { ru: "Лифтбек", kk: "Лифтбек", en: "Liftback" } },
  { kind: "body", code: "wagon", names: { ru: "Универсал", kk: "Универсал", en: "Station wagon" } },
  { kind: "body", code: "crossover", names: { ru: "Кроссовер", kk: "Кроссовер", en: "Crossover" } },
  { kind: "body", code: "suv", names: { ru: "Внедорожник", kk: "Жол талғамайтын", en: "SUV" } },
  {
    kind: "transmission",
    code: "mt",
    names: { ru: "Механическая", kk: "Механикалық", en: "Manual" },
  },
  {
    kind: "transmission",
    code: "at",
    names: { ru: "Автоматическая", kk: "Автоматты", en: "Automatic" },
  },
  { kind: "transmission", code: "cvt", names: { ru: "Вариатор", kk: "Вариатор", en: "CVT" } },
  {
    kind: "transmission",
    code: "dct",
    names: { ru: "Робот (DCT)", kk: "Робот (DCT)", en: "Dual-clutch (DCT)" },
  },
  { kind: "drive", code: "fwd", names: { ru: "Передний", kk: "Алдыңғы", en: "Front-wheel" } },
  { kind: "drive", code: "rwd", names: { ru: "Задний", kk: "Артқы", en: "Rear-wheel" } },
  { kind: "drive", code: "awd", names: { ru: "Полный", kk: "Толық", en: "All-wheel" } },
  { kind: "fuel", code: "petrol", names: { ru: "Бензин", kk: "Бензин", en: "Petrol" } },
  { kind: "fuel", code: "diesel", names: { ru: "Дизель", kk: "Дизель", en: "Diesel" } },
  { kind: "fuel", code: "hybrid", names: { ru: "Гибрид", kk: "Гибрид", en: "Hybrid" } },
  { kind: "fuel", code: "electric", names: { ru: "Электро", kk: "Электр", en: "Electric" } },
];

interface EngineSeed {
  code: string;
  aliases: string[];
  displacementL: number | null;
  fuel: string;
  powerHp: number | null;
}

export const devVehicleEngines: readonly EngineSeed[] = [
  { code: "JLH-3G15TD", aliases: ["3G15TD"], displacementL: 1.5, fuel: "petrol", powerHp: 177 },
  { code: "JLH-4G20TD", aliases: ["4G20TD"], displacementL: 2.0, fuel: "petrol", powerHp: 238 },
  { code: "JLH-4G20TDB", aliases: [], displacementL: 2.0, fuel: "petrol", powerHp: 238 },
  { code: "BHE15-EFZ", aliases: [], displacementL: 1.5, fuel: "petrol", powerHp: 122 },
  { code: "JLC-4G24", aliases: ["4G24"], displacementL: 2.4, fuel: "petrol", powerHp: 148 },
  { code: "SQRE4T15C", aliases: [], displacementL: 1.5, fuel: "petrol", powerHp: 147 },
];

interface ModificationSeed {
  body: string;
  engine: string;
  transmission: string;
  drive: string;
  yearFrom: number;
  yearTo: number | null;
  market: VehicleMarket;
}

interface GenerationSeed {
  name: string;
  yearFrom: number;
  yearTo: number | null;
  modifications: ModificationSeed[];
}

interface ModelSeed {
  name: string;
  aliases: string[];
  generations: GenerationSeed[];
}

interface MakeSeed {
  name: string;
  aliases: string[];
  models: ModelSeed[];
}

const kz = (
  body: string,
  engine: string,
  transmission: string,
  drive: string,
  yearFrom: number,
  yearTo: number | null = null,
): ModificationSeed => ({ body, engine, transmission, drive, yearFrom, yearTo, market: "kz" });

export const devVehicleMakes: readonly MakeSeed[] = [
  {
    name: "Geely",
    aliases: ["Geely Auto", "Джили"],
    models: [
      {
        name: "Coolray",
        aliases: ["Кулрей"],
        generations: [
          {
            name: "I (SX11)",
            yearFrom: 2019,
            yearTo: null,
            modifications: [kz("crossover", "JLH-3G15TD", "dct", "fwd", 2020)],
          },
        ],
      },
      {
        name: "Atlas",
        aliases: ["Атлас"],
        generations: [
          {
            name: "I (NL-3)",
            yearFrom: 2016,
            yearTo: 2022,
            modifications: [kz("crossover", "JLC-4G24", "at", "awd", 2018, 2022)],
          },
        ],
      },
      {
        name: "Atlas Pro",
        aliases: ["Атлас Про"],
        generations: [
          {
            name: "I (NL-3B)",
            yearFrom: 2021,
            yearTo: null,
            modifications: [
              kz("crossover", "JLH-3G15TD", "dct", "fwd", 2021),
              kz("crossover", "JLH-3G15TD", "dct", "awd", 2021),
            ],
          },
        ],
      },
      {
        name: "Monjaro",
        aliases: ["Монжаро"],
        generations: [
          {
            name: "I (KX11)",
            yearFrom: 2021,
            yearTo: null,
            modifications: [kz("crossover", "JLH-4G20TDB", "at", "awd", 2022)],
          },
        ],
      },
      {
        name: "Tugella",
        aliases: ["Тугелла"],
        generations: [
          {
            name: "I (FY11)",
            yearFrom: 2019,
            yearTo: null,
            modifications: [kz("crossover", "JLH-4G20TD", "at", "awd", 2020)],
          },
        ],
      },
      {
        name: "Emgrand",
        aliases: ["Эмгранд"],
        generations: [
          {
            name: "IV (SS11)",
            yearFrom: 2021,
            yearTo: null,
            modifications: [kz("sedan", "BHE15-EFZ", "cvt", "fwd", 2022)],
          },
        ],
      },
    ],
  },
  {
    name: "Chery",
    aliases: ["Чери"],
    models: [
      {
        name: "Tiggo 7 Pro",
        aliases: [],
        generations: [
          {
            name: "I",
            yearFrom: 2020,
            yearTo: null,
            modifications: [kz("crossover", "SQRE4T15C", "cvt", "fwd", 2020)],
          },
        ],
      },
    ],
  },
];

type SeedCounts = Record<
  "options" | "makes" | "models" | "generations" | "engines" | "modifications",
  number
>;

export interface DevVehicleSeedResult {
  created: SeedCounts;
  existing: SeedCounts;
}

export class DevVehicleSeedError extends Error {}

const OPERATOR: VehicleActor = { role: "operator" };

/**
 * Fills the vehicle catalog with the draft data above through the same
 * services the administrator uses (every check applies; every creation is
 * in the action journal by the operator). Idempotent: what exists — an
 * option by kind and code, a make or an engine by spelling, a model by
 * spelling within its make, a generation by name, a modification by its
 * identifying values — is left as it is, so a second run creates nothing.
 */
@Injectable()
export class DevVehicleSeed {
  private readonly logger = new Logger("Vehicles");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(VehicleOptionsService) private readonly options: VehicleOptionsService,
    @Inject(VehicleHierarchyService) private readonly hierarchy: VehicleHierarchyService,
    @Inject(VehicleModificationsService)
    private readonly modifications: VehicleModificationsService,
  ) {}

  async run(): Promise<DevVehicleSeedResult> {
    if (this.config.nodeEnv !== "development" && this.config.nodeEnv !== "test") {
      throw new DevVehicleSeedError(
        "The vehicle catalog is kept by the administrator; the example data is for development and tests only",
      );
    }
    const zero = (): SeedCounts => ({
      options: 0,
      makes: 0,
      models: 0,
      generations: 0,
      engines: 0,
      modifications: 0,
    });
    const result: DevVehicleSeedResult = { created: zero(), existing: zero() };
    const count = (kind: keyof SeedCounts, created: boolean) => {
      result[created ? "created" : "existing"][kind] += 1;
    };
    const db = this.database.db;

    const optionIds = new Map<string, string>();
    for (const seed of devVehicleOptions) {
      const [existing] = await db
        .select({ id: vehicleOption.id })
        .from(vehicleOption)
        .where(and(eq(vehicleOption.kind, seed.kind), eq(vehicleOption.code, seed.code)));
      const id = existing?.id ?? (await this.options.create(seed, OPERATOR)).id;
      count("options", !existing);
      optionIds.set(`${seed.kind}:${seed.code}`, id);
    }

    const engineIds = new Map<string, string>();
    for (const seed of devVehicleEngines) {
      const [existing] = await db
        .select({ id: vehicleEngineSpelling.engineId })
        .from(vehicleEngineSpelling)
        .where(eq(vehicleEngineSpelling.key, spellingKey(seed.code)));
      const id =
        existing?.id ??
        (
          await this.modifications.createEngine(
            {
              code: seed.code,
              aliases: seed.aliases,
              displacementL: seed.displacementL,
              fuelId: optionIds.get(`fuel:${seed.fuel}`)!,
              powerHp: seed.powerHp,
            },
            OPERATOR,
          )
        ).id;
      count("engines", !existing);
      engineIds.set(seed.code, id);
    }

    for (const make of devVehicleMakes) {
      const [existingMake] = await db
        .select({ id: vehicleMakeSpelling.makeId })
        .from(vehicleMakeSpelling)
        .where(eq(vehicleMakeSpelling.key, spellingKey(make.name)));
      const makeId =
        existingMake?.id ??
        (await this.hierarchy.createMake({ name: make.name, aliases: make.aliases }, OPERATOR)).id;
      count("makes", !existingMake);
      for (const model of make.models) {
        const [existingModel] = await db
          .select({ id: vehicleModelSpelling.modelId })
          .from(vehicleModelSpelling)
          .where(
            and(
              eq(vehicleModelSpelling.makeId, makeId),
              eq(vehicleModelSpelling.key, spellingKey(model.name)),
            ),
          );
        const modelId =
          existingModel?.id ??
          (
            await this.hierarchy.createModel(
              { makeId, name: model.name, aliases: model.aliases },
              OPERATOR,
            )
          ).id;
        count("models", !existingModel);
        for (const generation of model.generations) {
          const [existingGeneration] = await db
            .select({ id: vehicleGeneration.id })
            .from(vehicleGeneration)
            .where(
              and(
                eq(vehicleGeneration.modelId, modelId),
                eq(vehicleGeneration.nameKey, nameKey(generation.name)),
              ),
            );
          const generationId =
            existingGeneration?.id ??
            (
              await this.hierarchy.createGeneration(
                {
                  modelId,
                  name: generation.name,
                  yearFrom: generation.yearFrom,
                  yearTo: generation.yearTo,
                },
                OPERATOR,
              )
            ).id;
          count("generations", !existingGeneration);
          for (const modification of generation.modifications) {
            const values = {
              generationId,
              bodyTypeId: optionIds.get(`body:${modification.body}`)!,
              engineId: engineIds.get(modification.engine)!,
              transmissionTypeId: optionIds.get(`transmission:${modification.transmission}`)!,
              driveTypeId: optionIds.get(`drive:${modification.drive}`)!,
              yearFrom: modification.yearFrom,
              yearTo: modification.yearTo,
            };
            const [existingModification] = await db
              .select({ id: vehicleModification.id })
              .from(vehicleModification)
              .where(
                and(
                  eq(vehicleModification.generationId, values.generationId),
                  eq(vehicleModification.bodyTypeId, values.bodyTypeId),
                  eq(vehicleModification.engineId, values.engineId),
                  eq(vehicleModification.transmissionTypeId, values.transmissionTypeId),
                  eq(vehicleModification.driveTypeId, values.driveTypeId),
                  eq(vehicleModification.yearFrom, values.yearFrom),
                  sql`${vehicleModification.yearTo} IS NOT DISTINCT FROM ${values.yearTo}::smallint`,
                ),
              );
            if (!existingModification) {
              await this.modifications.createModification(
                { ...values, market: modification.market },
                OPERATOR,
              );
            }
            count("modifications", !existingModification);
          }
        }
      }
    }
    this.logger.log(
      `Development vehicle catalog seeded created=${JSON.stringify(result.created)} existing=${JSON.stringify(result.existing)}`,
    );
    return result;
  }
}
