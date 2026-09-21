import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  auditActions,
  auditEntities,
  type AdminVehicleEngine,
  type AdminVehicleEnginePage,
  type AdminVehicleModification,
  type AdminVehicleModificationPage,
  type CreateVehicleEngineBody,
  type CreateVehicleModificationBody,
  type UpdateVehicleEngineBody,
  type UpdateVehicleModificationBody,
  type VehicleEngineListQuery,
  type VehicleEntryStatus,
  type VehicleModificationListQuery,
  type VehicleOptionKind,
} from "@adclub/contracts";
import { and, asc, count, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { DatabaseService, type DbExecutor } from "../../database";
import { AuditLog } from "../audit";
import {
  Changes,
  decimal,
  decodeCursor,
  encodeCursor,
  iso,
  spellingKey,
  spellingsOf,
  TIME_POSITION,
  VEHICLE_LOCK,
  withinYears,
  type Spellings,
  type VehicleActor,
} from "./vehicle-common";
import {
  duplicate,
  notFound,
  parentArchived,
  referenceArchived,
  validationError,
  versionConflict,
  yearsInvalid,
} from "./vehicle-errors";
import { checkYearOrder, statusChange, VehicleHierarchyService } from "./vehicle-hierarchy.service";
import { optionRef } from "./vehicle-options.service";
import {
  vehicleEngine,
  vehicleEngineSpelling,
  vehicleGeneration,
  vehicleModification,
  vehicleOption,
  type VehicleEngineRow,
  type VehicleGenerationRow,
  type VehicleModificationRow,
  type VehicleOptionRow,
} from "./schema";

/** Writes the code and spellings of an engine. */
export async function writeEngineSpellings(
  executor: DbExecutor,
  engineId: string,
  spellings: Spellings,
): Promise<void> {
  await executor.insert(vehicleEngineSpelling).values([
    { engineId, text: spellings.name, key: spellingKey(spellings.name), isCode: true },
    ...spellings.aliases.map((text) => ({
      engineId,
      text,
      key: spellingKey(text),
      isCode: false,
    })),
  ]);
}

/** Code and other spellings of engines, by engine id. */
export async function engineSpellings(
  executor: DbExecutor,
  engineIds: readonly string[],
): Promise<Map<string, { code: string; aliases: string[] }>> {
  const result = new Map<string, { code: string; aliases: string[] }>();
  if (engineIds.length === 0) {
    return result;
  }
  const rows = await executor
    .select()
    .from(vehicleEngineSpelling)
    .where(inArray(vehicleEngineSpelling.engineId, [...new Set(engineIds)]))
    .orderBy(asc(vehicleEngineSpelling.key));
  for (const row of rows) {
    const entry = result.get(row.engineId) ?? { code: "", aliases: [] };
    if (row.isCode) {
      entry.code = row.text;
    } else {
      entry.aliases.push(row.text);
    }
    result.set(row.engineId, entry);
  }
  return result;
}

export async function optionsById(
  executor: DbExecutor,
  ids: readonly string[],
): Promise<Map<string, VehicleOptionRow>> {
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await executor
    .select()
    .from(vehicleOption)
    .where(inArray(vehicleOption.id, [...new Set(ids)]));
  return new Map(rows.map((row) => [row.id, row]));
}

/** The position of a modification in the admin list: its creation time to the microsecond. */
const createdPosition = sql<string>`to_char(${vehicleModification.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** A modification's values as the uniqueness of modifications sees them. */
interface ModificationValues {
  generationId: string;
  bodyTypeId: string;
  engineId: string;
  transmissionTypeId: string;
  driveTypeId: string;
  yearFrom: number;
  yearTo: number | null;
  market: "kz" | "global";
}

const OPTION_FIELDS = [
  ["bodyTypeId", "body"],
  ["transmissionTypeId", "transmission"],
  ["driveTypeId", "drive"],
] as const satisfies readonly [keyof ModificationValues, VehicleOptionKind][];

/**
 * Engines and modifications of the vehicle catalog for the administrator
 * (TASK-014 requirements 1–2; ARCHITECTURE 4.24). A modification is a
 * generation with a body, an engine, a transmission, a drive, years
 * within the generation's and a market; the same set of generation,
 * body, engine, transmission, drive and years is one modification.
 */
@Injectable()
export class VehicleModificationsService {
  private readonly logger = new Logger("Vehicles");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditLog) private readonly audit: AuditLog,
    @Inject(VehicleHierarchyService) private readonly hierarchy: VehicleHierarchyService,
  ) {}

  // -------------------------------------------------------------- engines

  async enginePage(query: VehicleEngineListQuery): Promise<AdminVehicleEnginePage> {
    const executor = this.database.db;
    const after = query.cursor ? decodeCursor(query.cursor) : undefined;
    const key = query.q ? spellingKey(query.q) : "";
    const filters: (SQL | undefined)[] = [
      query.status ? eq(vehicleEngine.status, query.status) : undefined,
      query.fuelId ? eq(vehicleEngine.fuelId, query.fuelId) : undefined,
      key
        ? sql`EXISTS (SELECT 1 FROM vehicle_engine_spelling s WHERE s.engine_id = ${vehicleEngine.id} AND strpos(s.key, ${key}) > 0)`
        : undefined,
    ];
    const position = sql<string>`${vehicleEngineSpelling.key} COLLATE "C"`;
    const [rows, [total]] = await Promise.all([
      executor
        .select({ engine: vehicleEngine, position })
        .from(vehicleEngine)
        .innerJoin(
          vehicleEngineSpelling,
          and(
            eq(vehicleEngineSpelling.engineId, vehicleEngine.id),
            eq(vehicleEngineSpelling.isCode, true),
          ),
        )
        .where(
          and(
            ...filters,
            after
              ? sql`(${position}, ${vehicleEngine.id}) > (${after.position}::text COLLATE "C", ${after.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(position, asc(vehicleEngine.id))
        .limit(query.limit + 1),
      executor
        .select({ value: count() })
        .from(vehicleEngine)
        .where(and(...filters)),
    ]);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      engines: await this.describeEngines(
        executor,
        page.map((row) => row.engine),
      ),
      total: total?.value ?? 0,
      nextCursor:
        rows.length > query.limit && last ? encodeCursor(last.position, last.engine.id) : null,
    };
  }

  async createEngine(
    input: CreateVehicleEngineBody,
    actor: VehicleActor,
  ): Promise<AdminVehicleEngine> {
    const spellings = spellingsOf(input.code, input.aliases ?? []);
    return this.database.db.transaction(async (tx) => {
      await tx.execute(VEHICLE_LOCK);
      await this.usableOption(tx, input.fuelId, "fuel", "fuelId");
      await this.assertEngineSpellingsFree(tx, spellings, undefined);
      const [row] = await tx
        .insert(vehicleEngine)
        .values({
          fuelId: input.fuelId,
          displacementL: input.displacementL == null ? null : input.displacementL.toFixed(2),
          powerHp: input.powerHp ?? null,
          source: "manual",
        })
        .returning();
      await writeEngineSpellings(tx, row!.id, spellings);
      const described = await this.describeEngine(tx, row!);
      await this.audit.record(
        {
          action: auditActions.vehicleEngineCreated,
          actor,
          entityType: auditEntities.vehicleEngine,
          entityId: row!.id,
          after: {
            code: described.code,
            aliases: described.aliases,
            fuel: described.fuel.code,
            displacementL: described.displacementL,
            powerHp: described.powerHp,
          },
        },
        tx,
      );
      return described;
    });
  }

  async updateEngine(
    engineId: string,
    input: UpdateVehicleEngineBody,
    actor: VehicleActor,
  ): Promise<AdminVehicleEngine> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(VEHICLE_LOCK);
      const row = await this.lockEngine(tx, engineId);
      if (row.version !== input.expectedVersion) {
        throw versionConflict(row.version);
      }
      const current = await this.describeEngine(tx, row);
      const spellings = spellingsOf(input.code ?? current.code, input.aliases ?? current.aliases);
      const wanted = {
        fuelId: input.fuelId ?? row.fuelId,
        displacementL:
          input.displacementL === undefined ? current.displacementL : input.displacementL,
        powerHp: input.powerHp === undefined ? row.powerHp : input.powerHp,
      };
      const changes = new Changes();
      changes.note("code", current.code, spellings.name);
      changes.note("aliases", [...current.aliases].sort(), [...spellings.aliases].sort());
      changes.note("fuelId", row.fuelId, wanted.fuelId);
      changes.note("displacementL", current.displacementL, wanted.displacementL);
      changes.note("powerHp", row.powerHp, wanted.powerHp);
      if (changes.empty) {
        return current;
      }
      if (changes.has("fuelId")) {
        await this.usableOption(tx, wanted.fuelId, "fuel", "fuelId");
      }
      if (changes.has("code") || changes.has("aliases")) {
        await this.assertEngineSpellingsFree(tx, spellings, row.id);
        await tx.delete(vehicleEngineSpelling).where(eq(vehicleEngineSpelling.engineId, row.id));
        await writeEngineSpellings(tx, row.id, spellings);
      }
      const [updated] = await tx
        .update(vehicleEngine)
        .set({
          fuelId: wanted.fuelId,
          displacementL: wanted.displacementL === null ? null : wanted.displacementL.toFixed(2),
          powerHp: wanted.powerHp,
          version: row.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(vehicleEngine.id, row.id))
        .returning();
      await this.audit.record(
        {
          action: auditActions.vehicleEngineChanged,
          actor,
          entityType: auditEntities.vehicleEngine,
          entityId: row.id,
          before: changes.before,
          after: { ...changes.after, version: updated!.version },
        },
        tx,
      );
      return this.describeEngine(tx, updated!);
    });
  }

  async setEngineStatus(
    engineId: string,
    status: VehicleEntryStatus,
    expectedVersion: number,
    actor: VehicleActor,
  ): Promise<AdminVehicleEngine> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(VEHICLE_LOCK);
      const row = await this.lockEngine(tx, engineId);
      if (row.version !== expectedVersion) {
        throw versionConflict(row.version);
      }
      if (row.status === status) {
        return this.describeEngine(tx, row);
      }
      const [updated] = await tx
        .update(vehicleEngine)
        .set(statusChange(status, row.version))
        .where(eq(vehicleEngine.id, row.id))
        .returning();
      await this.audit.record(
        {
          action: auditActions.vehicleEngineStatusChanged,
          actor,
          entityType: auditEntities.vehicleEngine,
          entityId: row.id,
          before: { status: row.status },
          after: { status, version: updated!.version },
        },
        tx,
      );
      return this.describeEngine(tx, updated!);
    });
  }

  // -------------------------------------------------------- modifications

  async modificationPage(
    query: VehicleModificationListQuery,
  ): Promise<AdminVehicleModificationPage> {
    const executor = this.database.db;
    const after = query.cursor ? decodeCursor(query.cursor) : undefined;
    if (after && !TIME_POSITION.test(after.position)) {
      throw validationError("cursor", "Use the nextCursor of the previous page");
    }
    const filters: (SQL | undefined)[] = [
      query.generationId ? eq(vehicleModification.generationId, query.generationId) : undefined,
      query.modelId
        ? sql`${vehicleModification.generationId} IN (SELECT id FROM vehicle_generation WHERE model_id = ${query.modelId})`
        : undefined,
      query.makeId
        ? sql`${vehicleModification.generationId} IN (SELECT g.id FROM vehicle_generation g JOIN vehicle_model m ON m.id = g.model_id WHERE m.make_id = ${query.makeId})`
        : undefined,
      query.engineId ? eq(vehicleModification.engineId, query.engineId) : undefined,
      query.year !== undefined
        ? sql`${vehicleModification.yearFrom} <= ${query.year} AND (${vehicleModification.yearTo} IS NULL OR ${vehicleModification.yearTo} >= ${query.year})`
        : undefined,
      query.market ? eq(vehicleModification.market, query.market) : undefined,
      query.source ? eq(vehicleModification.source, query.source) : undefined,
      query.status ? eq(vehicleModification.status, query.status) : undefined,
    ];
    const [rows, [total]] = await Promise.all([
      executor
        .select({ modification: vehicleModification, position: createdPosition })
        .from(vehicleModification)
        .where(
          and(
            ...filters,
            after
              ? sql`(${vehicleModification.createdAt}, ${vehicleModification.id}) < (${after.position}::timestamptz, ${after.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(vehicleModification.createdAt), desc(vehicleModification.id))
        .limit(query.limit + 1),
      executor
        .select({ value: count() })
        .from(vehicleModification)
        .where(and(...filters)),
    ]);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      modifications: await this.describeModifications(
        executor,
        page.map((row) => row.modification),
      ),
      total: total?.value ?? 0,
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor(last.position, last.modification.id)
          : null,
    };
  }

  async createModification(
    input: CreateVehicleModificationBody,
    actor: VehicleActor,
  ): Promise<AdminVehicleModification> {
    const values: ModificationValues = {
      generationId: input.generationId,
      bodyTypeId: input.bodyTypeId,
      engineId: input.engineId,
      transmissionTypeId: input.transmissionTypeId,
      driveTypeId: input.driveTypeId,
      yearFrom: input.yearFrom,
      yearTo: input.yearTo ?? null,
      market: input.market,
    };
    checkYearOrder(values.yearFrom, values.yearTo);
    return this.database.db.transaction(async (tx) => {
      await tx.execute(VEHICLE_LOCK);
      const generation = await this.usableGeneration(tx, values.generationId);
      for (const [field, kind] of OPTION_FIELDS) {
        await this.usableOption(tx, values[field] as string, kind, field);
      }
      await this.usableEngine(tx, values.engineId);
      assertWithin(values, generation);
      await this.assertModificationFree(tx, values, undefined);
      const [row] = await tx
        .insert(vehicleModification)
        .values({ ...values, source: "manual" })
        .returning();
      const described = await this.describeModification(tx, row!);
      await this.audit.record(
        {
          action: auditActions.vehicleModificationCreated,
          actor,
          entityType: auditEntities.vehicleModification,
          entityId: row!.id,
          after: values,
        },
        tx,
      );
      this.logger.log(`Vehicle modification created modification=${row!.id}`);
      return described;
    });
  }

  async updateModification(
    modificationId: string,
    input: UpdateVehicleModificationBody,
    actor: VehicleActor,
  ): Promise<AdminVehicleModification> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(VEHICLE_LOCK);
      const row = await this.lockModification(tx, modificationId);
      if (row.version !== input.expectedVersion) {
        throw versionConflict(row.version);
      }
      const wanted: ModificationValues = {
        generationId: input.generationId ?? row.generationId,
        bodyTypeId: input.bodyTypeId ?? row.bodyTypeId,
        engineId: input.engineId ?? row.engineId,
        transmissionTypeId: input.transmissionTypeId ?? row.transmissionTypeId,
        driveTypeId: input.driveTypeId ?? row.driveTypeId,
        yearFrom: input.yearFrom ?? row.yearFrom,
        yearTo: input.yearTo === undefined ? row.yearTo : input.yearTo,
        market: input.market ?? row.market,
      };
      const changes = new Changes();
      for (const field of Object.keys(wanted) as (keyof ModificationValues)[]) {
        changes.note(field, row[field], wanted[field]);
      }
      if (changes.empty) {
        return this.describeModification(tx, row);
      }
      checkYearOrder(wanted.yearFrom, wanted.yearTo);
      // A value that stays may be archived meanwhile — the modification
      // keeps it; a value being chosen now must be usable.
      const generation = changes.has("generationId")
        ? await this.usableGeneration(tx, wanted.generationId)
        : await this.findGeneration(tx, wanted.generationId);
      for (const [field, kind] of OPTION_FIELDS) {
        if (changes.has(field)) {
          await this.usableOption(tx, wanted[field] as string, kind, field);
        }
      }
      if (changes.has("engineId")) {
        await this.usableEngine(tx, wanted.engineId);
      }
      assertWithin(wanted, generation);
      await this.assertModificationFree(tx, wanted, row.id);
      const [updated] = await tx
        .update(vehicleModification)
        .set({ ...wanted, version: row.version + 1, updatedAt: new Date() })
        .where(eq(vehicleModification.id, row.id))
        .returning();
      await this.audit.record(
        {
          action: auditActions.vehicleModificationChanged,
          actor,
          entityType: auditEntities.vehicleModification,
          entityId: row.id,
          before: changes.before,
          after: { ...changes.after, version: updated!.version },
        },
        tx,
      );
      return this.describeModification(tx, updated!);
    });
  }

  async setModificationStatus(
    modificationId: string,
    status: VehicleEntryStatus,
    expectedVersion: number,
    actor: VehicleActor,
  ): Promise<AdminVehicleModification> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(VEHICLE_LOCK);
      const row = await this.lockModification(tx, modificationId);
      if (row.version !== expectedVersion) {
        throw versionConflict(row.version);
      }
      if (row.status === status) {
        return this.describeModification(tx, row);
      }
      if (status === "active") {
        await this.usableGeneration(tx, row.generationId);
      }
      const [updated] = await tx
        .update(vehicleModification)
        .set(statusChange(status, row.version))
        .where(eq(vehicleModification.id, row.id))
        .returning();
      await this.audit.record(
        {
          action: auditActions.vehicleModificationStatusChanged,
          actor,
          entityType: auditEntities.vehicleModification,
          entityId: row.id,
          before: { status: row.status },
          after: { status, version: updated!.version },
        },
        tx,
      );
      return this.describeModification(tx, updated!);
    });
  }

  // ----------------------------------------------------------- describing

  async describeEngines(
    executor: DbExecutor,
    rows: readonly VehicleEngineRow[],
  ): Promise<AdminVehicleEngine[]> {
    const [spellings, fuels] = await Promise.all([
      engineSpellings(
        executor,
        rows.map((row) => row.id),
      ),
      optionsById(
        executor,
        rows.map((row) => row.fuelId),
      ),
    ]);
    return rows.map((row) => {
      const own = spellings.get(row.id);
      return {
        id: row.id,
        code: own?.code ?? "",
        aliases: own?.aliases ?? [],
        displacementL: decimal(row.displacementL),
        fuel: optionRef(fuels.get(row.fuelId)!),
        powerHp: row.powerHp,
        source: row.source,
        status: row.status,
        version: row.version,
        archivedAt: iso(row.archivedAt),
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  }

  async describeModifications(
    executor: DbExecutor,
    rows: readonly VehicleModificationRow[],
  ): Promise<AdminVehicleModification[]> {
    if (rows.length === 0) {
      return [];
    }
    const generationRows = await executor
      .select()
      .from(vehicleGeneration)
      .where(inArray(vehicleGeneration.id, [...new Set(rows.map((row) => row.generationId))]));
    const engineRows = await executor
      .select()
      .from(vehicleEngine)
      .where(inArray(vehicleEngine.id, [...new Set(rows.map((row) => row.engineId))]));
    const [generations, engines, options] = await Promise.all([
      this.hierarchy.describeGenerations(executor, generationRows),
      this.describeEngines(executor, engineRows),
      optionsById(
        executor,
        rows.flatMap((row) => [row.bodyTypeId, row.transmissionTypeId, row.driveTypeId]),
      ),
    ]);
    const generationById = new Map(generations.map((entry) => [entry.id, entry]));
    const engineById = new Map(engines.map((entry) => [entry.id, entry]));
    return rows.map((row) => {
      const generation = generationById.get(row.generationId)!;
      const engine = engineById.get(row.engineId)!;
      return {
        id: row.id,
        make: generation.make,
        model: generation.model,
        generation: {
          id: generation.id,
          name: generation.name,
          status: generation.status,
          yearFrom: generation.yearFrom,
          yearTo: generation.yearTo,
        },
        bodyType: optionRef(options.get(row.bodyTypeId)!),
        engine: {
          id: engine.id,
          code: engine.code,
          displacementL: engine.displacementL,
          powerHp: engine.powerHp,
          fuel: engine.fuel,
          status: engine.status,
        },
        transmissionType: optionRef(options.get(row.transmissionTypeId)!),
        driveType: optionRef(options.get(row.driveTypeId)!),
        yearFrom: row.yearFrom,
        yearTo: row.yearTo,
        market: row.market,
        source: row.source,
        importId: row.importId,
        status: row.status,
        visibleToClients: row.status === "active" && generation.visibleToClients,
        version: row.version,
        archivedAt: iso(row.archivedAt),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  }

  // -------------------------------------------------------------- helpers

  private async describeEngine(executor: DbExecutor, row: VehicleEngineRow) {
    return (await this.describeEngines(executor, [row]))[0]!;
  }

  private async describeModification(executor: DbExecutor, row: VehicleModificationRow) {
    return (await this.describeModifications(executor, [row]))[0]!;
  }

  private async findGeneration(
    executor: DbExecutor,
    generationId: string,
  ): Promise<VehicleGenerationRow> {
    const [row] = await executor
      .select()
      .from(vehicleGeneration)
      .where(eq(vehicleGeneration.id, generationId));
    if (!row) {
      throw notFound("generation");
    }
    return row;
  }

  /** The generation exists and it, its model and its make are active. */
  private async usableGeneration(
    executor: DbExecutor,
    generationId: string,
  ): Promise<VehicleGenerationRow> {
    const generation = await this.findGeneration(executor, generationId);
    if (generation.status === "archived") {
      throw parentArchived("generation");
    }
    await this.hierarchy.assertModelUsable(
      executor,
      await this.hierarchy.findModel(executor, generation.modelId),
    );
    return generation;
  }

  private async usableOption(
    executor: DbExecutor,
    optionId: string,
    kind: VehicleOptionKind,
    field: string,
  ): Promise<VehicleOptionRow> {
    const [row] = await executor
      .select()
      .from(vehicleOption)
      .where(and(eq(vehicleOption.id, optionId), eq(vehicleOption.kind, kind)));
    if (!row) {
      throw validationError(field, `No such ${kind} option`);
    }
    if (row.status === "archived") {
      throw referenceArchived(field);
    }
    return row;
  }

  private async usableEngine(executor: DbExecutor, engineId: string): Promise<VehicleEngineRow> {
    const [row] = await executor.select().from(vehicleEngine).where(eq(vehicleEngine.id, engineId));
    if (!row) {
      throw validationError("engineId", "No such engine");
    }
    if (row.status === "archived") {
      throw referenceArchived("engineId");
    }
    return row;
  }

  private async lockEngine(executor: DbExecutor, engineId: string): Promise<VehicleEngineRow> {
    const [row] = await executor
      .select()
      .from(vehicleEngine)
      .where(eq(vehicleEngine.id, engineId))
      .for("update");
    if (!row) {
      throw notFound("engine");
    }
    return row;
  }

  private async lockModification(
    executor: DbExecutor,
    modificationId: string,
  ): Promise<VehicleModificationRow> {
    const [row] = await executor
      .select()
      .from(vehicleModification)
      .where(eq(vehicleModification.id, modificationId))
      .for("update");
    if (!row) {
      throw notFound("modification");
    }
    return row;
  }

  private async assertEngineSpellingsFree(
    executor: DbExecutor,
    spellings: Spellings,
    selfId: string | undefined,
  ): Promise<void> {
    const texts = [spellings.name, ...spellings.aliases];
    const taken = await executor
      .select()
      .from(vehicleEngineSpelling)
      .where(
        inArray(
          vehicleEngineSpelling.key,
          texts.map((text) => spellingKey(text)),
        ),
      );
    const clash = taken.find((row) => row.engineId !== selfId);
    if (clash) {
      throw duplicate(
        "engine",
        clash.engineId,
        texts.find((text) => spellingKey(text) === clash.key)!,
      );
    }
  }

  /** No other modification (archived ones included) has the same identifying values. */
  private async assertModificationFree(
    executor: DbExecutor,
    values: ModificationValues,
    selfId: string | undefined,
  ): Promise<void> {
    const [clash] = await executor
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
    if (clash && clash.id !== selfId) {
      throw duplicate("modification", clash.id);
    }
  }
}

function assertWithin(values: ModificationValues, generation: VehicleGenerationRow): void {
  if (!withinYears(values, generation)) {
    throw yearsInvalid({
      reason: "outside_generation",
      generationYears: { from: generation.yearFrom, to: generation.yearTo },
      modificationIds: [],
    });
  }
}
