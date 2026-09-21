import { Inject, Injectable } from "@nestjs/common";
import {
  auditActions,
  auditEntities,
  type AdminVehicleOption,
  type AdminVehicleOptionRef,
  type CreateVehicleOptionBody,
  type UpdateVehicleOptionBody,
  type VehicleEntryStatus,
  type VehicleOptionKind,
  type VehicleOptionListQuery,
  type VehicleOptionNames,
} from "@adclub/contracts";
import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { DatabaseService, type DbExecutor } from "../../database";
import { AuditLog } from "../audit";
import {
  Changes,
  iso,
  nameKey,
  normalizeText,
  VEHICLE_LOCK,
  type VehicleActor,
} from "./vehicle-common";
import { duplicate, notFound, versionConflict } from "./vehicle-errors";
import { vehicleOption, type VehicleOptionRow } from "./schema";

export function optionNames(row: VehicleOptionRow): VehicleOptionNames {
  return { ru: row.nameRu, kk: row.nameKk, en: row.nameEn };
}

export function describeOption(row: VehicleOptionRow): AdminVehicleOption {
  return {
    id: row.id,
    kind: row.kind,
    code: row.code,
    names: optionNames(row),
    sort: row.sort,
    status: row.status,
    version: row.version,
    archivedAt: iso(row.archivedAt),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function optionRef(row: VehicleOptionRow): AdminVehicleOptionRef {
  return {
    id: row.id,
    kind: row.kind,
    code: row.code,
    names: optionNames(row),
    status: row.status,
  };
}

/**
 * The reference lists of the vehicle catalog — body types, transmissions,
 * drives, fuels (TASK-014 requirement 1; ARCHITECTURE 4.24). Names are
 * written by hand in kk/ru/en and never translated automatically; a name
 * means one option of its kind in every language, case ignored, so an
 * import file can name an option by code or by any name without doubt.
 */
@Injectable()
export class VehicleOptionsService {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditLog) private readonly audit: AuditLog,
  ) {}

  async list(query: VehicleOptionListQuery): Promise<AdminVehicleOption[]> {
    const conditions: (SQL | undefined)[] = [
      query.kind ? eq(vehicleOption.kind, query.kind) : undefined,
      query.status ? eq(vehicleOption.status, query.status) : undefined,
    ];
    const rows = await this.database.db
      .select()
      .from(vehicleOption)
      .where(and(...conditions))
      .orderBy(asc(vehicleOption.kind), asc(vehicleOption.sort), asc(vehicleOption.code));
    return rows.map(describeOption);
  }

  async create(input: CreateVehicleOptionBody, actor: VehicleActor): Promise<AdminVehicleOption> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(VEHICLE_LOCK);
      const names = {
        ru: normalizeText(input.names.ru),
        kk: input.names.kk ? normalizeText(input.names.kk) : null,
        en: input.names.en ? normalizeText(input.names.en) : null,
      };
      const [sameCode] = await tx
        .select({ id: vehicleOption.id })
        .from(vehicleOption)
        .where(and(eq(vehicleOption.kind, input.kind), eq(vehicleOption.code, input.code)));
      if (sameCode) {
        throw duplicate("option", sameCode.id, input.code);
      }
      await this.assertNamesFree(tx, input.kind, names, undefined);
      const [last] = await tx
        .select({ sort: sql<number>`coalesce(max(${vehicleOption.sort}), -1)` })
        .from(vehicleOption)
        .where(eq(vehicleOption.kind, input.kind));
      const [row] = await tx
        .insert(vehicleOption)
        .values({
          kind: input.kind,
          code: input.code,
          nameRu: names.ru,
          nameKk: names.kk,
          nameEn: names.en,
          sort: Number(last?.sort ?? -1) + 1,
        })
        .returning();
      const described = describeOption(row!);
      await this.audit.record(
        {
          action: auditActions.vehicleOptionCreated,
          actor,
          entityType: auditEntities.vehicleOption,
          entityId: row!.id,
          after: { kind: described.kind, code: described.code, names: described.names },
        },
        tx,
      );
      return described;
    });
  }

  async update(
    optionId: string,
    input: UpdateVehicleOptionBody,
    actor: VehicleActor,
  ): Promise<AdminVehicleOption> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(VEHICLE_LOCK);
      const row = await this.lock(tx, optionId);
      if (row.version !== input.expectedVersion) {
        throw versionConflict(row.version);
      }
      const current = optionNames(row);
      const wanted: VehicleOptionNames = { ...current };
      if (input.names?.ru !== undefined) {
        wanted.ru = normalizeText(input.names.ru);
      }
      for (const lang of ["kk", "en"] as const) {
        const value = input.names?.[lang];
        if (value !== undefined) {
          wanted[lang] = value === null ? null : normalizeText(value);
        }
      }
      const changes = new Changes();
      changes.note("names", current, wanted);
      if (changes.empty) {
        return describeOption(row);
      }
      await this.assertNamesFree(tx, row.kind, wanted, row.id);
      const [updated] = await tx
        .update(vehicleOption)
        .set({
          nameRu: wanted.ru,
          nameKk: wanted.kk,
          nameEn: wanted.en,
          version: row.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(vehicleOption.id, row.id))
        .returning();
      await this.audit.record(
        {
          action: auditActions.vehicleOptionChanged,
          actor,
          entityType: auditEntities.vehicleOption,
          entityId: row.id,
          before: changes.before,
          after: { ...changes.after, version: updated!.version },
        },
        tx,
      );
      return describeOption(updated!);
    });
  }

  async setStatus(
    optionId: string,
    status: VehicleEntryStatus,
    expectedVersion: number,
    actor: VehicleActor,
  ): Promise<AdminVehicleOption> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(VEHICLE_LOCK);
      const row = await this.lock(tx, optionId);
      if (row.version !== expectedVersion) {
        throw versionConflict(row.version);
      }
      if (row.status === status) {
        return describeOption(row);
      }
      const [updated] = await tx
        .update(vehicleOption)
        .set({
          status,
          archivedAt: status === "archived" ? new Date() : null,
          version: row.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(vehicleOption.id, row.id))
        .returning();
      await this.audit.record(
        {
          action: auditActions.vehicleOptionStatusChanged,
          actor,
          entityType: auditEntities.vehicleOption,
          entityId: row.id,
          before: { status: row.status },
          after: { status, version: updated!.version },
        },
        tx,
      );
      return describeOption(updated!);
    });
  }

  /** An option of this kind (for a modification or an engine), or a validation error on `field`. */
  async ofKind(
    executor: DbExecutor,
    optionId: string,
    kind: VehicleOptionKind,
  ): Promise<VehicleOptionRow | undefined> {
    const [row] = await executor
      .select()
      .from(vehicleOption)
      .where(and(eq(vehicleOption.id, optionId), eq(vehicleOption.kind, kind)));
    return row;
  }

  private async lock(executor: DbExecutor, optionId: string): Promise<VehicleOptionRow> {
    const [row] = await executor
      .select()
      .from(vehicleOption)
      .where(eq(vehicleOption.id, optionId))
      .for("update");
    if (!row) {
      throw notFound("option");
    }
    return row;
  }

  /** No other option of the kind has one of these names in any language (case ignored). */
  private async assertNamesFree(
    executor: DbExecutor,
    kind: VehicleOptionKind,
    names: VehicleOptionNames,
    selfId: string | undefined,
  ): Promise<void> {
    const rows = await executor.select().from(vehicleOption).where(eq(vehicleOption.kind, kind));
    const wanted = [names.ru, names.kk, names.en].filter((name): name is string => name !== null);
    for (const other of rows) {
      if (other.id === selfId) {
        continue;
      }
      const taken = new Set(
        [other.nameRu, other.nameKk, other.nameEn, other.code]
          .filter((name): name is string => name !== null)
          .map(nameKey),
      );
      const clash = wanted.find((name) => taken.has(nameKey(name)));
      if (clash) {
        throw duplicate("option", other.id, clash);
      }
    }
  }
}
