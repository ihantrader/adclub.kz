import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  auditActions,
  auditEntities,
  type AdminVehicleGeneration,
  type AdminVehicleGenerationPage,
  type AdminVehicleMake,
  type AdminVehicleMakePage,
  type AdminVehicleModel,
  type AdminVehicleModelPage,
  type CreateVehicleGenerationBody,
  type CreateVehicleMakeBody,
  type CreateVehicleModelBody,
  type UpdateVehicleGenerationBody,
  type UpdateVehicleMakeBody,
  type UpdateVehicleModelBody,
  type VehicleEntryStatus,
  type VehicleGenerationListQuery,
  type VehicleMakeListQuery,
  type VehicleModelListQuery,
} from "@adclub/contracts";
import { and, asc, count, eq, inArray, sql, type SQL } from "drizzle-orm";
import { DatabaseService, type DbExecutor } from "../../database";
import { AuditLog } from "../audit";
import {
  Changes,
  decodeCursor,
  encodeCursor,
  iso,
  nameKey,
  normalizeText,
  spellingKey,
  spellingsOf,
  VEHICLE_LOCK,
  type Spellings,
  type VehicleActor,
} from "./vehicle-common";
import {
  duplicate,
  notFound,
  parentArchived,
  versionConflict,
  yearsInvalid,
} from "./vehicle-errors";
import {
  vehicleGeneration,
  vehicleMake,
  vehicleMakeSpelling,
  vehicleModel,
  vehicleModelSpelling,
  vehicleModification,
  type VehicleGenerationRow,
  type VehicleMakeRow,
  type VehicleModelRow,
} from "./schema";

/** A make's or model's name and spellings as read for describing. */
export interface NamedSpellings {
  name: string;
  key: string;
  aliases: string[];
}

/** Name and spellings of makes, by make id. */
export async function makeSpellings(
  executor: DbExecutor,
  makeIds: readonly string[],
): Promise<Map<string, NamedSpellings>> {
  const result = new Map<string, NamedSpellings>();
  if (makeIds.length === 0) {
    return result;
  }
  const rows = await executor
    .select()
    .from(vehicleMakeSpelling)
    .where(inArray(vehicleMakeSpelling.makeId, [...new Set(makeIds)]))
    .orderBy(asc(vehicleMakeSpelling.key));
  for (const row of rows) {
    const entry = result.get(row.makeId) ?? { name: "", key: "", aliases: [] };
    if (row.isName) {
      entry.name = row.text;
      entry.key = row.key;
    } else {
      entry.aliases.push(row.text);
    }
    result.set(row.makeId, entry);
  }
  return result;
}

/** Name and spellings of models, by model id. */
export async function modelSpellings(
  executor: DbExecutor,
  modelIds: readonly string[],
): Promise<Map<string, NamedSpellings>> {
  const result = new Map<string, NamedSpellings>();
  if (modelIds.length === 0) {
    return result;
  }
  const rows = await executor
    .select()
    .from(vehicleModelSpelling)
    .where(inArray(vehicleModelSpelling.modelId, [...new Set(modelIds)]))
    .orderBy(asc(vehicleModelSpelling.key));
  for (const row of rows) {
    const entry = result.get(row.modelId) ?? { name: "", key: "", aliases: [] };
    if (row.isName) {
      entry.name = row.text;
      entry.key = row.key;
    } else {
      entry.aliases.push(row.text);
    }
    result.set(row.modelId, entry);
  }
  return result;
}

/** Writes the name and spellings of a make. */
export async function writeMakeSpellings(
  executor: DbExecutor,
  makeId: string,
  spellings: Spellings,
): Promise<void> {
  await executor
    .insert(vehicleMakeSpelling)
    .values([
      { makeId, text: spellings.name, key: spellingKey(spellings.name), isName: true },
      ...spellings.aliases.map((text) => ({ makeId, text, key: spellingKey(text), isName: false })),
    ]);
}

/** Writes the name and spellings of a model. */
export async function writeModelSpellings(
  executor: DbExecutor,
  modelId: string,
  makeId: string,
  spellings: Spellings,
): Promise<void> {
  await executor.insert(vehicleModelSpelling).values([
    { modelId, makeId, text: spellings.name, key: spellingKey(spellings.name), isName: true },
    ...spellings.aliases.map((text) => ({
      modelId,
      makeId,
      text,
      key: spellingKey(text),
      isName: false,
    })),
  ]);
}

/** The keyset position of a model in the admin list: its make's name, then its own. */
const modelPosition = sql<string>`(mk.key || chr(1) || ms.key) COLLATE "C"`;

/**
 * The keyset position of a generation: make, model, first year (four
 * digits), name — so the list reads as the catalog does.
 */
const generationPosition = sql<string>`(mk.key || chr(1) || ms.key || chr(1) || lpad(${vehicleGeneration.yearFrom}::text, 4, '0') || chr(1) || ${vehicleGeneration.nameKey}) COLLATE "C"`;

/**
 * Makes, models and generations of the vehicle catalog for the
 * administrator (TASK-014 requirements 1–2; ARCHITECTURE 4.24): creation,
 * changes, moving a model to another make and a generation to another
 * model, archiving and restoring. Every change takes the vehicle lock,
 * checks the version it was made from and is written to the action
 * journal in its transaction.
 */
@Injectable()
export class VehicleHierarchyService {
  private readonly logger = new Logger("Vehicles");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditLog) private readonly audit: AuditLog,
  ) {}

  // ---------------------------------------------------------------- makes

  async makePage(query: VehicleMakeListQuery): Promise<AdminVehicleMakePage> {
    const executor = this.database.db;
    const after = query.cursor ? decodeCursor(query.cursor) : undefined;
    const key = query.q ? spellingKey(query.q) : "";
    const filters: (SQL | undefined)[] = [
      query.status ? eq(vehicleMake.status, query.status) : undefined,
      key
        ? sql`EXISTS (SELECT 1 FROM vehicle_make_spelling s WHERE s.make_id = ${vehicleMake.id} AND strpos(s.key, ${key}) > 0)`
        : undefined,
    ];
    const nameJoin = and(
      eq(vehicleMakeSpelling.makeId, vehicleMake.id),
      eq(vehicleMakeSpelling.isName, true),
    );
    const position = sql<string>`${vehicleMakeSpelling.key} COLLATE "C"`;
    const [rows, [total]] = await Promise.all([
      executor
        .select({ make: vehicleMake, position })
        .from(vehicleMake)
        .innerJoin(vehicleMakeSpelling, nameJoin)
        .where(
          and(
            ...filters,
            after
              ? sql`(${position}, ${vehicleMake.id}) > (${after.position}::text COLLATE "C", ${after.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(position, asc(vehicleMake.id))
        .limit(query.limit + 1),
      executor
        .select({ value: count() })
        .from(vehicleMake)
        .where(and(...filters)),
    ]);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      makes: await this.describeMakes(
        executor,
        page.map((row) => row.make),
      ),
      total: total?.value ?? 0,
      nextCursor:
        rows.length > query.limit && last ? encodeCursor(last.position, last.make.id) : null,
    };
  }

  async createMake(input: CreateVehicleMakeBody, actor: VehicleActor): Promise<AdminVehicleMake> {
    const spellings = spellingsOf(input.name, input.aliases ?? []);
    return this.database.db.transaction(async (tx) => {
      await tx.execute(VEHICLE_LOCK);
      await this.assertMakeSpellingsFree(tx, spellings, undefined);
      const [row] = await tx.insert(vehicleMake).values({ source: "manual" }).returning();
      await writeMakeSpellings(tx, row!.id, spellings);
      const described = await this.describeMake(tx, row!);
      await this.audit.record(
        {
          action: auditActions.vehicleMakeCreated,
          actor,
          entityType: auditEntities.vehicleMake,
          entityId: row!.id,
          after: { name: described.name, aliases: described.aliases },
        },
        tx,
      );
      this.logger.log(`Vehicle make created make=${row!.id}`);
      return described;
    });
  }

  async updateMake(
    makeId: string,
    input: UpdateVehicleMakeBody,
    actor: VehicleActor,
  ): Promise<AdminVehicleMake> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(VEHICLE_LOCK);
      const row = await this.lockMake(tx, makeId);
      if (row.version !== input.expectedVersion) {
        throw versionConflict(row.version);
      }
      const current = await this.describeMake(tx, row);
      const spellings = spellingsOf(input.name ?? current.name, input.aliases ?? current.aliases);
      const changes = new Changes();
      changes.note("name", current.name, spellings.name);
      changes.note("aliases", [...current.aliases].sort(), [...spellings.aliases].sort());
      if (changes.empty) {
        return current;
      }
      await this.assertMakeSpellingsFree(tx, spellings, row.id);
      await tx.delete(vehicleMakeSpelling).where(eq(vehicleMakeSpelling.makeId, row.id));
      await writeMakeSpellings(tx, row.id, spellings);
      const [updated] = await tx
        .update(vehicleMake)
        .set({ version: row.version + 1, updatedAt: new Date() })
        .where(eq(vehicleMake.id, row.id))
        .returning();
      await this.audit.record(
        {
          action: auditActions.vehicleMakeChanged,
          actor,
          entityType: auditEntities.vehicleMake,
          entityId: row.id,
          before: changes.before,
          after: { ...changes.after, version: updated!.version },
        },
        tx,
      );
      return this.describeMake(tx, updated!);
    });
  }

  async setMakeStatus(
    makeId: string,
    status: VehicleEntryStatus,
    expectedVersion: number,
    actor: VehicleActor,
  ): Promise<AdminVehicleMake> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(VEHICLE_LOCK);
      const row = await this.lockMake(tx, makeId);
      if (row.version !== expectedVersion) {
        throw versionConflict(row.version);
      }
      if (row.status === status) {
        return this.describeMake(tx, row);
      }
      const [updated] = await tx
        .update(vehicleMake)
        .set(statusChange(status, row.version))
        .where(eq(vehicleMake.id, row.id))
        .returning();
      await this.audit.record(
        {
          action: auditActions.vehicleMakeStatusChanged,
          actor,
          entityType: auditEntities.vehicleMake,
          entityId: row.id,
          before: { status: row.status },
          after: { status, version: updated!.version },
        },
        tx,
      );
      this.logger.log(`Vehicle make status make=${row.id} from=${row.status} to=${status}`);
      return this.describeMake(tx, updated!);
    });
  }

  // --------------------------------------------------------------- models

  async modelPage(query: VehicleModelListQuery): Promise<AdminVehicleModelPage> {
    const executor = this.database.db;
    const after = query.cursor ? decodeCursor(query.cursor) : undefined;
    const key = query.q ? spellingKey(query.q) : "";
    const filters = [
      query.makeId ? sql`${vehicleModel.makeId} = ${query.makeId}` : undefined,
      query.status ? sql`${vehicleModel.status} = ${query.status}` : undefined,
      key
        ? sql`EXISTS (SELECT 1 FROM vehicle_model_spelling s WHERE s.model_id = ${vehicleModel.id} AND strpos(s.key, ${key}) > 0)`
        : undefined,
    ].filter((entry): entry is SQL => entry !== undefined);
    const where = (extra: SQL | undefined) => {
      const all = extra ? [...filters, extra] : filters;
      return all.length > 0 ? sql`WHERE ${sql.join(all, sql` AND `)}` : sql``;
    };
    const from = sql`FROM vehicle_model
      JOIN vehicle_model_spelling ms ON ms.model_id = vehicle_model.id AND ms.is_name
      JOIN vehicle_make_spelling mk ON mk.make_id = vehicle_model.make_id AND mk.is_name`;
    const cursorCondition = after
      ? sql`(${modelPosition}, vehicle_model.id) > (${after.position}::text COLLATE "C", ${after.id}::uuid)`
      : undefined;
    const [rows, totals] = await Promise.all([
      executor.execute<{ id: string; position: string }>(
        sql`SELECT vehicle_model.id, ${modelPosition} AS position ${from} ${where(cursorCondition)}
            ORDER BY ${modelPosition}, vehicle_model.id LIMIT ${query.limit + 1}`,
      ),
      executor.execute<{ total: number }>(
        sql`SELECT count(*)::int AS total FROM vehicle_model ${where(undefined)}`,
      ),
    ]);
    const page = rows.rows.slice(0, query.limit);
    const last = page.at(-1);
    const models = await this.loadModels(
      executor,
      page.map((row) => row.id),
    );
    return {
      models: await this.describeModels(executor, models),
      total: totals.rows[0]?.total ?? 0,
      nextCursor:
        rows.rows.length > query.limit && last ? encodeCursor(last.position, last.id) : null,
    };
  }

  async createModel(
    input: CreateVehicleModelBody,
    actor: VehicleActor,
  ): Promise<AdminVehicleModel> {
    const spellings = spellingsOf(input.name, input.aliases ?? []);
    return this.database.db.transaction(async (tx) => {
      await tx.execute(VEHICLE_LOCK);
      const make = await this.findMake(tx, input.makeId);
      if (make.status === "archived") {
        throw parentArchived("make");
      }
      await this.assertModelSpellingsFree(tx, make.id, spellings, undefined);
      const [row] = await tx
        .insert(vehicleModel)
        .values({ makeId: make.id, source: "manual" })
        .returning();
      await writeModelSpellings(tx, row!.id, make.id, spellings);
      const described = await this.describeModel(tx, row!);
      await this.audit.record(
        {
          action: auditActions.vehicleModelCreated,
          actor,
          entityType: auditEntities.vehicleModel,
          entityId: row!.id,
          after: { makeId: make.id, name: described.name, aliases: described.aliases },
        },
        tx,
      );
      return described;
    });
  }

  async updateModel(
    modelId: string,
    input: UpdateVehicleModelBody,
    actor: VehicleActor,
  ): Promise<AdminVehicleModel> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(VEHICLE_LOCK);
      const row = await this.lockModel(tx, modelId);
      if (row.version !== input.expectedVersion) {
        throw versionConflict(row.version);
      }
      const current = await this.describeModel(tx, row);
      const makeId = input.makeId ?? row.makeId;
      const spellings = spellingsOf(input.name ?? current.name, input.aliases ?? current.aliases);
      const changes = new Changes();
      changes.note("makeId", row.makeId, makeId);
      changes.note("name", current.name, spellings.name);
      changes.note("aliases", [...current.aliases].sort(), [...spellings.aliases].sort());
      if (changes.empty) {
        return current;
      }
      if (changes.has("makeId")) {
        const make = await this.findMake(tx, makeId);
        if (make.status === "archived") {
          throw parentArchived("make");
        }
      }
      await this.assertModelSpellingsFree(tx, makeId, spellings, row.id);
      // Spellings go first: the new make's unique key must see the model's
      // names gone from the old one before the move cascades their make.
      await tx.delete(vehicleModelSpelling).where(eq(vehicleModelSpelling.modelId, row.id));
      const [updated] = await tx
        .update(vehicleModel)
        .set({ makeId, version: row.version + 1, updatedAt: new Date() })
        .where(eq(vehicleModel.id, row.id))
        .returning();
      await writeModelSpellings(tx, row.id, makeId, spellings);
      await this.audit.record(
        {
          action: auditActions.vehicleModelChanged,
          actor,
          entityType: auditEntities.vehicleModel,
          entityId: row.id,
          before: changes.before,
          after: { ...changes.after, version: updated!.version },
        },
        tx,
      );
      return this.describeModel(tx, updated!);
    });
  }

  async setModelStatus(
    modelId: string,
    status: VehicleEntryStatus,
    expectedVersion: number,
    actor: VehicleActor,
  ): Promise<AdminVehicleModel> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(VEHICLE_LOCK);
      const row = await this.lockModel(tx, modelId);
      if (row.version !== expectedVersion) {
        throw versionConflict(row.version);
      }
      if (row.status === status) {
        return this.describeModel(tx, row);
      }
      if (status === "active") {
        const make = await this.findMake(tx, row.makeId);
        if (make.status === "archived") {
          throw parentArchived("make");
        }
      }
      const [updated] = await tx
        .update(vehicleModel)
        .set(statusChange(status, row.version))
        .where(eq(vehicleModel.id, row.id))
        .returning();
      await this.audit.record(
        {
          action: auditActions.vehicleModelStatusChanged,
          actor,
          entityType: auditEntities.vehicleModel,
          entityId: row.id,
          before: { status: row.status },
          after: { status, version: updated!.version },
        },
        tx,
      );
      return this.describeModel(tx, updated!);
    });
  }

  // ---------------------------------------------------------- generations

  async generationPage(query: VehicleGenerationListQuery): Promise<AdminVehicleGenerationPage> {
    const executor = this.database.db;
    const after = query.cursor ? decodeCursor(query.cursor) : undefined;
    const filters = [
      query.modelId ? sql`${vehicleGeneration.modelId} = ${query.modelId}` : undefined,
      query.makeId ? sql`vehicle_model.make_id = ${query.makeId}` : undefined,
      query.status ? sql`${vehicleGeneration.status} = ${query.status}` : undefined,
      query.year !== undefined
        ? sql`${vehicleGeneration.yearFrom} <= ${query.year} AND (${vehicleGeneration.yearTo} IS NULL OR ${vehicleGeneration.yearTo} >= ${query.year})`
        : undefined,
      query.q ? sql`strpos(${vehicleGeneration.nameKey}, ${nameKey(query.q)}) > 0` : undefined,
    ].filter((entry): entry is SQL => entry !== undefined);
    const where = (extra: SQL | undefined) => {
      const all = extra ? [...filters, extra] : filters;
      return all.length > 0 ? sql`WHERE ${sql.join(all, sql` AND `)}` : sql``;
    };
    const from = sql`FROM vehicle_generation
      JOIN vehicle_model ON vehicle_model.id = vehicle_generation.model_id
      JOIN vehicle_model_spelling ms ON ms.model_id = vehicle_model.id AND ms.is_name
      JOIN vehicle_make_spelling mk ON mk.make_id = vehicle_model.make_id AND mk.is_name`;
    const cursorCondition = after
      ? sql`(${generationPosition}, vehicle_generation.id) > (${after.position}::text COLLATE "C", ${after.id}::uuid)`
      : undefined;
    const [rows, totals] = await Promise.all([
      executor.execute<{ id: string; position: string }>(
        sql`SELECT vehicle_generation.id, ${generationPosition} AS position ${from} ${where(cursorCondition)}
            ORDER BY ${generationPosition}, vehicle_generation.id LIMIT ${query.limit + 1}`,
      ),
      executor.execute<{ total: number }>(
        sql`SELECT count(*)::int AS total FROM vehicle_generation
            JOIN vehicle_model ON vehicle_model.id = vehicle_generation.model_id ${where(undefined)}`,
      ),
    ]);
    const page = rows.rows.slice(0, query.limit);
    const last = page.at(-1);
    const ids = page.map((row) => row.id);
    const generations =
      ids.length === 0
        ? []
        : await executor.select().from(vehicleGeneration).where(inArray(vehicleGeneration.id, ids));
    const byId = new Map(generations.map((row) => [row.id, row]));
    return {
      generations: await this.describeGenerations(
        executor,
        ids.map((id) => byId.get(id)!),
      ),
      total: totals.rows[0]?.total ?? 0,
      nextCursor:
        rows.rows.length > query.limit && last ? encodeCursor(last.position, last.id) : null,
    };
  }

  async createGeneration(
    input: CreateVehicleGenerationBody,
    actor: VehicleActor,
  ): Promise<AdminVehicleGeneration> {
    const name = normalizeText(input.name);
    const yearTo = input.yearTo ?? null;
    checkYearOrder(input.yearFrom, yearTo);
    return this.database.db.transaction(async (tx) => {
      await tx.execute(VEHICLE_LOCK);
      const model = await this.findModel(tx, input.modelId);
      await this.assertModelUsable(tx, model);
      await this.assertGenerationNameFree(tx, model.id, name, undefined);
      const [row] = await tx
        .insert(vehicleGeneration)
        .values({
          modelId: model.id,
          name,
          nameKey: nameKey(name),
          yearFrom: input.yearFrom,
          yearTo,
          source: "manual",
        })
        .returning();
      await this.audit.record(
        {
          action: auditActions.vehicleGenerationCreated,
          actor,
          entityType: auditEntities.vehicleGeneration,
          entityId: row!.id,
          after: { modelId: model.id, name, yearFrom: input.yearFrom, yearTo },
        },
        tx,
      );
      return this.describeGeneration(tx, row!);
    });
  }

  async updateGeneration(
    generationId: string,
    input: UpdateVehicleGenerationBody,
    actor: VehicleActor,
  ): Promise<AdminVehicleGeneration> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(VEHICLE_LOCK);
      const row = await this.lockGeneration(tx, generationId);
      if (row.version !== input.expectedVersion) {
        throw versionConflict(row.version);
      }
      const wanted = {
        modelId: input.modelId ?? row.modelId,
        name: input.name === undefined ? row.name : normalizeText(input.name),
        yearFrom: input.yearFrom ?? row.yearFrom,
        yearTo: input.yearTo === undefined ? row.yearTo : input.yearTo,
      };
      const changes = new Changes();
      changes.note("modelId", row.modelId, wanted.modelId);
      changes.note("name", row.name, wanted.name);
      changes.note("yearFrom", row.yearFrom, wanted.yearFrom);
      changes.note("yearTo", row.yearTo, wanted.yearTo);
      if (changes.empty) {
        return this.describeGeneration(tx, row);
      }
      checkYearOrder(wanted.yearFrom, wanted.yearTo);
      if (changes.has("modelId")) {
        await this.assertModelUsable(tx, await this.findModel(tx, wanted.modelId));
      }
      if (changes.has("modelId") || changes.has("name")) {
        await this.assertGenerationNameFree(tx, wanted.modelId, wanted.name, row.id);
      }
      if (changes.has("yearFrom") || changes.has("yearTo")) {
        await this.assertCoversModifications(tx, row.id, wanted.yearFrom, wanted.yearTo);
      }
      const [updated] = await tx
        .update(vehicleGeneration)
        .set({
          ...wanted,
          nameKey: nameKey(wanted.name),
          version: row.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(vehicleGeneration.id, row.id))
        .returning();
      await this.audit.record(
        {
          action: auditActions.vehicleGenerationChanged,
          actor,
          entityType: auditEntities.vehicleGeneration,
          entityId: row.id,
          before: changes.before,
          after: { ...changes.after, version: updated!.version },
        },
        tx,
      );
      return this.describeGeneration(tx, updated!);
    });
  }

  async setGenerationStatus(
    generationId: string,
    status: VehicleEntryStatus,
    expectedVersion: number,
    actor: VehicleActor,
  ): Promise<AdminVehicleGeneration> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(VEHICLE_LOCK);
      const row = await this.lockGeneration(tx, generationId);
      if (row.version !== expectedVersion) {
        throw versionConflict(row.version);
      }
      if (row.status === status) {
        return this.describeGeneration(tx, row);
      }
      if (status === "active") {
        await this.assertModelUsable(tx, await this.findModel(tx, row.modelId));
      }
      const [updated] = await tx
        .update(vehicleGeneration)
        .set(statusChange(status, row.version))
        .where(eq(vehicleGeneration.id, row.id))
        .returning();
      await this.audit.record(
        {
          action: auditActions.vehicleGenerationStatusChanged,
          actor,
          entityType: auditEntities.vehicleGeneration,
          entityId: row.id,
          before: { status: row.status },
          after: { status, version: updated!.version },
        },
        tx,
      );
      return this.describeGeneration(tx, updated!);
    });
  }

  // ---------------------------------------------------------- describing

  async describeMakes(
    executor: DbExecutor,
    rows: readonly VehicleMakeRow[],
  ): Promise<AdminVehicleMake[]> {
    const spellings = await makeSpellings(
      executor,
      rows.map((row) => row.id),
    );
    return rows.map((row) => {
      const own = spellings.get(row.id);
      return {
        id: row.id,
        name: own?.name ?? "",
        aliases: own?.aliases ?? [],
        source: row.source,
        status: row.status,
        version: row.version,
        archivedAt: iso(row.archivedAt),
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  }

  async describeModels(
    executor: DbExecutor,
    rows: readonly VehicleModelRow[],
  ): Promise<AdminVehicleModel[]> {
    const makeIds = rows.map((row) => row.makeId);
    const [spellings, makes, makeRows] = await Promise.all([
      modelSpellings(
        executor,
        rows.map((row) => row.id),
      ),
      makeSpellings(executor, makeIds),
      makeIds.length === 0
        ? Promise.resolve([] as VehicleMakeRow[])
        : executor
            .select()
            .from(vehicleMake)
            .where(inArray(vehicleMake.id, [...new Set(makeIds)])),
    ]);
    const makeStatus = new Map(makeRows.map((row) => [row.id, row.status]));
    return rows.map((row) => {
      const own = spellings.get(row.id);
      const status = makeStatus.get(row.makeId) ?? "archived";
      return {
        id: row.id,
        make: { id: row.makeId, name: makes.get(row.makeId)?.name ?? "", status },
        name: own?.name ?? "",
        aliases: own?.aliases ?? [],
        source: row.source,
        status: row.status,
        visibleToClients: row.status === "active" && status === "active",
        version: row.version,
        archivedAt: iso(row.archivedAt),
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  }

  async describeGenerations(
    executor: DbExecutor,
    rows: readonly VehicleGenerationRow[],
  ): Promise<AdminVehicleGeneration[]> {
    const models = await this.describeModels(
      executor,
      await this.loadModels(
        executor,
        rows.map((row) => row.modelId),
      ),
    );
    const byId = new Map(models.map((model) => [model.id, model]));
    return rows.map((row) => {
      const model = byId.get(row.modelId)!;
      return {
        id: row.id,
        make: model.make,
        model: { id: model.id, name: model.name, status: model.status },
        name: row.name,
        yearFrom: row.yearFrom,
        yearTo: row.yearTo,
        source: row.source,
        status: row.status,
        visibleToClients: row.status === "active" && model.visibleToClients,
        version: row.version,
        archivedAt: iso(row.archivedAt),
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  }

  async loadModels(executor: DbExecutor, ids: readonly string[]): Promise<VehicleModelRow[]> {
    if (ids.length === 0) {
      return [];
    }
    const rows = await executor
      .select()
      .from(vehicleModel)
      .where(inArray(vehicleModel.id, [...new Set(ids)]));
    const byId = new Map(rows.map((row) => [row.id, row]));
    return [...new Set(ids)].map((id) => byId.get(id)!).filter(Boolean);
  }

  // ------------------------------------------------------------- helpers

  /** The model exists, is active and so is its make — something may be added under it. */
  async assertModelUsable(executor: DbExecutor, model: VehicleModelRow): Promise<void> {
    if (model.status === "archived") {
      throw parentArchived("model");
    }
    const make = await this.findMake(executor, model.makeId);
    if (make.status === "archived") {
      throw parentArchived("make");
    }
  }

  async findMake(executor: DbExecutor, makeId: string): Promise<VehicleMakeRow> {
    const [row] = await executor.select().from(vehicleMake).where(eq(vehicleMake.id, makeId));
    if (!row) {
      throw notFound("make");
    }
    return row;
  }

  async findModel(executor: DbExecutor, modelId: string): Promise<VehicleModelRow> {
    const [row] = await executor.select().from(vehicleModel).where(eq(vehicleModel.id, modelId));
    if (!row) {
      throw notFound("model");
    }
    return row;
  }

  private async describeMake(executor: DbExecutor, row: VehicleMakeRow): Promise<AdminVehicleMake> {
    return (await this.describeMakes(executor, [row]))[0]!;
  }

  private async describeModel(
    executor: DbExecutor,
    row: VehicleModelRow,
  ): Promise<AdminVehicleModel> {
    return (await this.describeModels(executor, [row]))[0]!;
  }

  private async describeGeneration(
    executor: DbExecutor,
    row: VehicleGenerationRow,
  ): Promise<AdminVehicleGeneration> {
    return (await this.describeGenerations(executor, [row]))[0]!;
  }

  private async lockMake(executor: DbExecutor, makeId: string): Promise<VehicleMakeRow> {
    const [row] = await executor
      .select()
      .from(vehicleMake)
      .where(eq(vehicleMake.id, makeId))
      .for("update");
    if (!row) {
      throw notFound("make");
    }
    return row;
  }

  private async lockModel(executor: DbExecutor, modelId: string): Promise<VehicleModelRow> {
    const [row] = await executor
      .select()
      .from(vehicleModel)
      .where(eq(vehicleModel.id, modelId))
      .for("update");
    if (!row) {
      throw notFound("model");
    }
    return row;
  }

  private async lockGeneration(
    executor: DbExecutor,
    generationId: string,
  ): Promise<VehicleGenerationRow> {
    const [row] = await executor
      .select()
      .from(vehicleGeneration)
      .where(eq(vehicleGeneration.id, generationId))
      .for("update");
    if (!row) {
      throw notFound("generation");
    }
    return row;
  }

  private async assertMakeSpellingsFree(
    executor: DbExecutor,
    spellings: Spellings,
    selfId: string | undefined,
  ): Promise<void> {
    const texts = [spellings.name, ...spellings.aliases];
    const taken = await executor
      .select()
      .from(vehicleMakeSpelling)
      .where(
        inArray(
          vehicleMakeSpelling.key,
          texts.map((text) => spellingKey(text)),
        ),
      );
    const clash = taken.find((row) => row.makeId !== selfId);
    if (clash) {
      throw duplicate(
        "make",
        clash.makeId,
        texts.find((text) => spellingKey(text) === clash.key)!,
      );
    }
  }

  private async assertModelSpellingsFree(
    executor: DbExecutor,
    makeId: string,
    spellings: Spellings,
    selfId: string | undefined,
  ): Promise<void> {
    const texts = [spellings.name, ...spellings.aliases];
    const taken = await executor
      .select()
      .from(vehicleModelSpelling)
      .where(
        and(
          eq(vehicleModelSpelling.makeId, makeId),
          inArray(
            vehicleModelSpelling.key,
            texts.map((text) => spellingKey(text)),
          ),
        ),
      );
    const clash = taken.find((row) => row.modelId !== selfId);
    if (clash) {
      throw duplicate(
        "model",
        clash.modelId,
        texts.find((text) => spellingKey(text) === clash.key)!,
      );
    }
  }

  private async assertGenerationNameFree(
    executor: DbExecutor,
    modelId: string,
    name: string,
    selfId: string | undefined,
  ): Promise<void> {
    const [clash] = await executor
      .select({ id: vehicleGeneration.id })
      .from(vehicleGeneration)
      .where(
        and(eq(vehicleGeneration.modelId, modelId), eq(vehicleGeneration.nameKey, nameKey(name))),
      );
    if (clash && clash.id !== selfId) {
      throw duplicate("generation", clash.id, name);
    }
  }

  /** New years of a generation must still hold every one of its modifications, archived too. */
  private async assertCoversModifications(
    executor: DbExecutor,
    generationId: string,
    yearFrom: number,
    yearTo: number | null,
  ): Promise<void> {
    const outside = await executor
      .select({ id: vehicleModification.id })
      .from(vehicleModification)
      .where(
        and(
          eq(vehicleModification.generationId, generationId),
          yearTo === null
            ? sql`${vehicleModification.yearFrom} < ${yearFrom}`
            : sql`(${vehicleModification.yearFrom} < ${yearFrom} OR ${vehicleModification.yearTo} IS NULL OR ${vehicleModification.yearTo} > ${yearTo})`,
        ),
      )
      .limit(20);
    if (outside.length > 0) {
      throw yearsInvalid({
        reason: "modifications_outside",
        generationYears: { from: yearFrom, to: yearTo },
        modificationIds: outside.map((row) => row.id),
      });
    }
  }
}

/** The years are in order (the end, if any, not before the start). */
export function checkYearOrder(yearFrom: number, yearTo: number | null): void {
  if (yearTo !== null && yearTo < yearFrom) {
    throw yearsInvalid({ reason: "order", generationYears: null, modificationIds: [] });
  }
}

/** Archived or restored, with the next version. */
export function statusChange(status: VehicleEntryStatus, version: number) {
  return {
    status,
    archivedAt: status === "archived" ? new Date() : null,
    version: version + 1,
    updatedAt: new Date(),
  };
}
