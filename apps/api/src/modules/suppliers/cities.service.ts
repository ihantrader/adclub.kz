import { Inject, Injectable } from "@nestjs/common";
import {
  auditActions,
  auditEntities,
  DEFAULT_TIME_ZONE,
  type AdminCity,
  type CatalogLanguage,
  type CityListResponse,
  type CityNames,
  type CityRef,
  type CityStatus,
  type CreateCityBody,
  type LocalizedText,
  type UpdateCityBody,
} from "@adclub/contracts";
import { asc, eq, sql } from "drizzle-orm";
import { ApiException } from "../../common/errors";
import { DatabaseService, type DbExecutor } from "../../database";
import { AuditLog } from "../audit";
import { normalizeText } from "../catalog";
import { AppSettings } from "../settings";
import { city, type CityRow } from "./schema";
import {
  Changes,
  CITY_LOCK,
  cityArchived,
  cityDuplicate,
  cityVersionConflict,
  iso,
  notFound,
  timeZoneOf,
  validationError,
  type SupplierAdminActor,
} from "./supplier-common";

export function cityNames(row: CityRow): CityNames {
  return { ru: row.nameRu, kk: row.nameKk, en: row.nameEn };
}

export function cityRef(row: CityRow): CityRef {
  return { id: row.id, code: row.code, names: cityNames(row), status: row.status };
}

function localizedName(row: CityRow, lang: CatalogLanguage): LocalizedText {
  const own = lang === "kk" ? row.nameKk : lang === "en" ? row.nameEn : row.nameRu;
  return own === null
    ? { text: row.nameRu, isFallback: lang !== "ru" }
    : { text: own, isFallback: false };
}

function nameKey(text: string): string {
  return normalizeText(text).toLowerCase();
}

/** Whether a row matches a setting value: its code, or (values of before the directory) a name. */
function matches(row: CityRow, value: string): boolean {
  if (row.code === value) {
    return true;
  }
  const key = nameKey(value);
  return [row.nameRu, row.nameKk, row.nameEn].some(
    (name) => name !== null && nameKey(name) === key,
  );
}

/**
 * The directory of cities (TASK-016 requirement 1; ARCHITECTURE 4.26):
 * names in kk/ru/en written by hand (never translated automatically), a
 * time zone, an order, archiving instead of deletion. The city of a
 * supplier, of a request and of a pickup point is one of these; clients
 * choose from the active ones (`GET /cities`).
 */
@Injectable()
export class CitiesService {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditLog) private readonly audit: AuditLog,
    @Inject(AppSettings) private readonly settings: AppSettings,
  ) {}

  async listAdmin(executor: DbExecutor = this.database.db): Promise<AdminCity[]> {
    const rows = await this.ordered(executor);
    const defaultId = await this.defaultCityId(rows);
    return rows.map((row) => this.describe(row, defaultId));
  }

  /** Active cities in their order, in the language asked for (guests and every session). */
  async listForClients(lang: CatalogLanguage): Promise<CityListResponse> {
    const rows = await this.ordered(this.database.db);
    const active = rows.filter((row) => row.status === "active");
    return {
      language: lang,
      defaultCityId: await this.defaultCityId(active),
      cities: active.map((row) => ({
        id: row.id,
        code: row.code,
        name: localizedName(row, lang),
        timeZone: row.timeZone,
      })),
    };
  }

  /**
   * The city of the setting `default_city` among `rows`: by code, or by a
   * name (a value of before the directory). Not active or unknown — the
   * first active city in the order, so a client always gets one while any
   * city exists.
   */
  async defaultCityId(rows: readonly CityRow[]): Promise<string | null> {
    const value = await this.settings.get("default_city");
    const active = rows.filter((row) => row.status === "active");
    return (active.find((row) => matches(row, value)) ?? active[0])?.id ?? null;
  }

  async create(input: CreateCityBody, actor: SupplierAdminActor): Promise<AdminCity> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(CITY_LOCK);
      const names: CityNames = {
        ru: normalizeText(input.names.ru),
        kk: input.names.kk ? normalizeText(input.names.kk) : null,
        en: input.names.en ? normalizeText(input.names.en) : null,
      };
      const timeZone = timeZoneOf("timeZone", input.timeZone ?? DEFAULT_TIME_ZONE);
      const [sameCode] = await tx
        .select({ id: city.id })
        .from(city)
        .where(eq(city.code, input.code));
      if (sameCode) {
        throw cityDuplicate({ existingId: sameCode.id, field: "code", value: input.code });
      }
      await this.assertNamesFree(tx, names, undefined);
      const [last] = await tx
        .select({ sort: sql<number>`coalesce(max(${city.sort}), -1)` })
        .from(city);
      const [row] = await tx
        .insert(city)
        .values({
          code: input.code,
          nameRu: names.ru,
          nameKk: names.kk,
          nameEn: names.en,
          timeZone,
          sort: Number(last?.sort ?? -1) + 1,
          source: "manual",
        })
        .returning();
      await this.audit.record(
        {
          action: auditActions.cityCreated,
          actor,
          entityType: auditEntities.city,
          entityId: row!.id,
          after: { code: row!.code, names, timeZone },
        },
        tx,
      );
      return this.describe(row!, await this.defaultCityId(await this.ordered(tx)));
    });
  }

  async update(
    cityId: string,
    input: UpdateCityBody,
    actor: SupplierAdminActor,
  ): Promise<AdminCity> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(CITY_LOCK);
      const row = await this.lock(tx, cityId);
      if (row.version !== input.expectedVersion) {
        throw cityVersionConflict(row.version);
      }
      const current = cityNames(row);
      const wanted: CityNames = { ...current };
      if (input.names?.ru !== undefined) {
        wanted.ru = normalizeText(input.names.ru);
      }
      for (const lang of ["kk", "en"] as const) {
        const value = input.names?.[lang];
        if (value !== undefined) {
          wanted[lang] = value === null ? null : normalizeText(value);
        }
      }
      const timeZone =
        input.timeZone === undefined ? row.timeZone : timeZoneOf("timeZone", input.timeZone);
      const changes = new Changes();
      changes.note("names", current, wanted);
      changes.note("timeZone", row.timeZone, timeZone);
      if (changes.empty) {
        return this.describe(row, await this.defaultCityId(await this.ordered(tx)));
      }
      await this.assertNamesFree(tx, wanted, row.id);
      const [updated] = await tx
        .update(city)
        .set({
          nameRu: wanted.ru,
          nameKk: wanted.kk,
          nameEn: wanted.en,
          timeZone,
          version: row.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(city.id, row.id))
        .returning();
      await this.audit.record(
        {
          action: auditActions.cityChanged,
          actor,
          entityType: auditEntities.city,
          entityId: row.id,
          before: changes.before,
          after: { ...changes.after, version: updated!.version },
        },
        tx,
      );
      return this.describe(updated!, await this.defaultCityId(await this.ordered(tx)));
    });
  }

  /**
   * Archive or restore. An archived city stays with whoever has it
   * (suppliers, requests, pickup points); it is no longer offered.
   */
  async setStatus(
    cityId: string,
    status: CityStatus,
    expectedVersion: number,
    actor: SupplierAdminActor,
  ): Promise<AdminCity> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(CITY_LOCK);
      const row = await this.lock(tx, cityId);
      if (row.version !== expectedVersion) {
        throw cityVersionConflict(row.version);
      }
      if (row.status === status) {
        return this.describe(row, await this.defaultCityId(await this.ordered(tx)));
      }
      const [updated] = await tx
        .update(city)
        .set({
          status,
          archivedAt: status === "archived" ? new Date() : null,
          version: row.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(city.id, row.id))
        .returning();
      await this.audit.record(
        {
          action: auditActions.cityStatusChanged,
          actor,
          entityType: auditEntities.city,
          entityId: row.id,
          before: { status: row.status },
          after: { status, version: updated!.version },
        },
        tx,
      );
      return this.describe(updated!, await this.defaultCityId(await this.ordered(tx)));
    });
  }

  /** Every city exactly once, in the new order. */
  async reorder(cityIds: readonly string[], actor: SupplierAdminActor): Promise<AdminCity[]> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(CITY_LOCK);
      const rows = await this.ordered(tx);
      const known = new Set(rows.map((row) => row.id));
      const wanted = new Set(cityIds);
      if (
        wanted.size !== cityIds.length ||
        wanted.size !== known.size ||
        cityIds.some((id) => !known.has(id))
      ) {
        throw new ApiException(
          409,
          "CITY_ORDER_MISMATCH",
          "The new order must name every city exactly once; reload the list",
        );
      }
      const before = rows.map((row) => row.id);
      if (before.join() !== cityIds.join()) {
        for (const [index, id] of cityIds.entries()) {
          await tx.update(city).set({ sort: index, updatedAt: new Date() }).where(eq(city.id, id));
        }
        await this.audit.record(
          {
            action: auditActions.citiesReordered,
            actor,
            entityType: auditEntities.city,
            entityId: "cities",
            before,
            after: [...cityIds],
          },
          tx,
        );
      }
      return this.listAdmin(tx);
    });
  }

  /**
   * The city a request or a supplier is given: it exists (else a
   * validation error on `field`) and is active (else `CITY_ARCHIVED`),
   * unless it is the one already there (`current`) — keeping an archived
   * city is not choosing it.
   */
  async choose(
    executor: DbExecutor,
    cityId: string,
    field: string,
    current?: string,
  ): Promise<CityRow> {
    const [row] = await executor.select().from(city).where(eq(city.id, cityId));
    if (!row) {
      throw validationError(field, "No such city");
    }
    if (row.status !== "active" && row.id !== current) {
      throw cityArchived(field);
    }
    return row;
  }

  async byId(executor: DbExecutor, cityId: string): Promise<CityRow> {
    const [row] = await executor.select().from(city).where(eq(city.id, cityId));
    if (!row) {
      throw notFound("city");
    }
    return row;
  }

  private describe(row: CityRow, defaultId: string | null): AdminCity {
    return {
      id: row.id,
      code: row.code,
      names: cityNames(row),
      timeZone: row.timeZone,
      sort: row.sort,
      status: row.status,
      source: row.source,
      isDefault: row.id === defaultId,
      version: row.version,
      archivedAt: iso(row.archivedAt),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private ordered(executor: DbExecutor): Promise<CityRow[]> {
    return executor.select().from(city).orderBy(asc(city.sort), asc(city.nameRu), asc(city.id));
  }

  private async lock(executor: DbExecutor, cityId: string): Promise<CityRow> {
    const [row] = await executor.select().from(city).where(eq(city.id, cityId)).for("update");
    if (!row) {
      throw notFound("city");
    }
    return row;
  }

  /** No other city has one of these names in any language (case ignored). */
  private async assertNamesFree(
    executor: DbExecutor,
    names: CityNames,
    selfId: string | undefined,
  ): Promise<void> {
    const rows = await executor.select().from(city);
    const wanted = [names.ru, names.kk, names.en].filter((name): name is string => name !== null);
    for (const other of rows) {
      if (other.id === selfId) {
        continue;
      }
      const taken = new Set(
        [other.nameRu, other.nameKk, other.nameEn]
          .filter((name): name is string => name !== null)
          .map(nameKey),
      );
      const clash = wanted.find((name) => taken.has(nameKey(name)));
      if (clash) {
        throw cityDuplicate({ existingId: other.id, field: "name", value: clash });
      }
    }
  }
}
