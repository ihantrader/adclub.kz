import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  auditActions,
  auditEntities,
  type AdminBrand,
  type AdminBrandPage,
  type BrandListQuery,
  type CatalogEntryStatus,
  type CreateBrandBody,
  type UpdateBrandBody,
} from "@adclub/contracts";
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { DatabaseService, type DbExecutor } from "../../database";
import { AuditLog } from "../audit";
import type { CatalogActor } from "./catalog-admin.service";
import { brandSpellingTaken, notFound, validationError, versionConflict } from "./catalog-errors";
import { decodeCursor, encodeCursor, uniqueViolation } from "./catalog-paging";
import { normalizeText } from "./catalog-texts";
import { brand, brandSpelling, type BrandRow, type BrandSpellingRow } from "./schema";

/**
 * A spelling as the uniqueness of brands sees it: case and whitespace
 * don't matter (`GEELY Auto` = `geelyauto`; TASK-011 requirement 1).
 */
export function spellingKey(text: string): string {
  return normalizeText(text).toLowerCase().replace(/\s+/gu, "");
}

interface Spellings {
  name: string;
  aliases: string[];
}

/**
 * Brands of the catalog for the administrator (TASK-011 requirement 1;
 * ARCHITECTURE 4.17): a name, other spellings, the OEM flag. The name and
 * every spelling are unique among all brands (archived ones too) — the
 * unique key of `brand_spelling` holds it, the service answers first with
 * `CATALOG_BRAND_SPELLING_TAKEN`. An archived brand can't be chosen for an
 * item; items keep it.
 */
@Injectable()
export class CatalogBrandsService {
  private readonly logger = new Logger("Catalog");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditLog) private readonly audit: AuditLog,
  ) {}

  async page(query: BrandListQuery): Promise<AdminBrandPage> {
    const after = query.cursor ? decodeCursor(query.cursor) : undefined;
    const key = query.q ? spellingKey(query.q) : "";
    const conditions: (SQL | undefined)[] = [
      query.status ? eq(brand.status, query.status) : undefined,
      key
        ? sql`EXISTS (SELECT 1 FROM brand_spelling s WHERE s.brand_id = ${brand.id} AND strpos(s.key, ${key}) > 0)`
        : undefined,
      after
        ? sql`(${brandSpelling.key}, ${brand.id}) > (${after.position}, ${after.id}::uuid)`
        : undefined,
    ];
    const rows = await this.database.db
      .select({ brand, key: brandSpelling.key })
      .from(brand)
      .innerJoin(
        brandSpelling,
        and(eq(brandSpelling.brandId, brand.id), eq(brandSpelling.isName, true)),
      )
      .where(and(...conditions))
      .orderBy(asc(brandSpelling.key), asc(brand.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const described = await this.describeMany(
      this.database.db,
      page.map((row) => row.brand),
    );
    const last = page.at(-1);
    return {
      brands: described,
      nextCursor: rows.length > query.limit && last ? encodeCursor(last.key, last.brand.id) : null,
    };
  }

  async create(input: CreateBrandBody, actor: CatalogActor): Promise<AdminBrand> {
    const spellings = this.spellings(input.name, input.aliases ?? []);
    return this.guardSpellings([spellings.name, ...spellings.aliases], undefined, () =>
      this.database.db.transaction(async (tx) => {
        await this.assertSpellingsFree(tx, [spellings.name, ...spellings.aliases], undefined);
        const [row] = await tx
          .insert(brand)
          .values({ isOem: input.isOem ?? false })
          .returning();
        const created = row!;
        await this.writeSpellings(tx, created.id, spellings);
        const described = await this.describe(tx, created);
        await this.audit.record(
          {
            action: auditActions.catalogBrandCreated,
            actor,
            entityType: auditEntities.catalogBrand,
            entityId: created.id,
            after: { name: described.name, aliases: described.aliases, isOem: described.isOem },
          },
          tx,
        );
        this.logger.log(`Brand created brand=${created.id}`);
        return described;
      }),
    );
  }

  async update(brandId: string, input: UpdateBrandBody, actor: CatalogActor): Promise<AdminBrand> {
    const asked = [...(input.name ? [input.name] : []), ...(input.aliases ?? [])];
    return this.guardSpellings(asked, brandId, () =>
      this.database.db.transaction(async (tx) => {
        const row = await this.lockBrand(tx, brandId);
        if (row.version !== input.expectedVersion) {
          throw versionConflict(row.version);
        }
        const current = await this.describe(tx, row);
        const spellings = this.spellings(
          input.name ?? current.name,
          input.aliases ?? current.aliases,
        );
        const isOem = input.isOem ?? row.isOem;
        const changedBefore: Record<string, unknown> = {};
        const changedAfter: Record<string, unknown> = {};
        const note = (field: string, was: unknown, now: unknown) => {
          if (JSON.stringify(was) !== JSON.stringify(now)) {
            changedBefore[field] = was;
            changedAfter[field] = now;
          }
        };
        note("name", current.name, spellings.name);
        note("aliases", [...current.aliases].sort(), [...spellings.aliases].sort());
        note("isOem", row.isOem, isOem);
        if (Object.keys(changedAfter).length === 0) {
          return current;
        }
        if ("name" in changedAfter || "aliases" in changedAfter) {
          await this.assertSpellingsFree(tx, [spellings.name, ...spellings.aliases], row.id);
          await tx.delete(brandSpelling).where(eq(brandSpelling.brandId, row.id));
          await this.writeSpellings(tx, row.id, spellings);
        }
        const [updated] = await tx
          .update(brand)
          .set({ isOem, version: row.version + 1, updatedAt: new Date() })
          .where(eq(brand.id, row.id))
          .returning();
        await this.audit.record(
          {
            action: auditActions.catalogBrandChanged,
            actor,
            entityType: auditEntities.catalogBrand,
            entityId: row.id,
            before: changedBefore,
            after: { ...changedAfter, version: updated!.version },
          },
          tx,
        );
        return this.describe(tx, updated!);
      }),
    );
  }

  async setStatus(
    brandId: string,
    status: CatalogEntryStatus,
    expectedVersion: number,
    actor: CatalogActor,
  ): Promise<AdminBrand> {
    return this.database.db.transaction(async (tx) => {
      const row = await this.lockBrand(tx, brandId);
      if (row.version !== expectedVersion) {
        throw versionConflict(row.version);
      }
      if (row.status === status) {
        return this.describe(tx, row);
      }
      const [updated] = await tx
        .update(brand)
        .set({
          status,
          archivedAt: status === "archived" ? new Date() : null,
          version: row.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(brand.id, row.id))
        .returning();
      await this.audit.record(
        {
          action: auditActions.catalogBrandStatusChanged,
          actor,
          entityType: auditEntities.catalogBrand,
          entityId: row.id,
          before: { status: row.status },
          after: { status, version: updated!.version },
        },
        tx,
      );
      this.logger.log(`Brand status brand=${row.id} from=${row.status} to=${status}`);
      return this.describe(tx, updated!);
    });
  }

  /** The brand that has this spelling, if any (the development seed). */
  async findBySpelling(text: string): Promise<BrandRow | undefined> {
    const [row] = await this.database.db
      .select({ brand })
      .from(brandSpelling)
      .innerJoin(brand, eq(brand.id, brandSpelling.brandId))
      .where(eq(brandSpelling.key, spellingKey(text)));
    return row?.brand;
  }

  async describeMany(executor: DbExecutor, rows: readonly BrandRow[]): Promise<AdminBrand[]> {
    if (rows.length === 0) {
      return [];
    }
    const spellings = await executor
      .select()
      .from(brandSpelling)
      .where(
        inArray(
          brandSpelling.brandId,
          rows.map((row) => row.id),
        ),
      )
      .orderBy(asc(brandSpelling.key));
    return rows.map((row) => this.toAdminBrand(row, spellings));
  }

  private async describe(executor: DbExecutor, row: BrandRow): Promise<AdminBrand> {
    return (await this.describeMany(executor, [row]))[0]!;
  }

  private toAdminBrand(row: BrandRow, spellings: readonly BrandSpellingRow[]): AdminBrand {
    const own = spellings.filter((spelling) => spelling.brandId === row.id);
    return {
      id: row.id,
      name: own.find((spelling) => spelling.isName)?.text ?? "",
      aliases: own.filter((spelling) => !spelling.isName).map((spelling) => spelling.text),
      isOem: row.isOem,
      status: row.status,
      version: row.version,
      archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async lockBrand(executor: DbExecutor, brandId: string): Promise<BrandRow> {
    const [row] = await executor.select().from(brand).where(eq(brand.id, brandId)).for("update");
    if (!row) {
      throw notFound("brand");
    }
    return row;
  }

  /** Normalized, and none of them the same as another (case and spaces ignored). */
  private spellings(name: string, aliases: readonly string[]): Spellings {
    const normalizedName = normalizeText(name);
    const seen = new Set([spellingKey(normalizedName)]);
    const unique: string[] = [];
    for (const [index, alias] of aliases.entries()) {
      const text = normalizeText(alias);
      const key = spellingKey(text);
      if (seen.has(key)) {
        throw validationError(
          `aliases.${index}`,
          "The spelling repeats the name or another spelling (case and spaces are ignored)",
        );
      }
      seen.add(key);
      unique.push(text);
    }
    return { name: normalizedName, aliases: unique };
  }

  private async assertSpellingsFree(
    executor: DbExecutor,
    texts: readonly string[],
    selfId: string | undefined,
  ): Promise<void> {
    if (texts.length === 0) {
      return;
    }
    const taken = await executor
      .select()
      .from(brandSpelling)
      .where(
        inArray(
          brandSpelling.key,
          texts.map((text) => spellingKey(text)),
        ),
      );
    const clash = taken.find((row) => row.brandId !== selfId);
    if (clash) {
      const text = texts.find((entry) => spellingKey(entry) === clash.key)!;
      throw brandSpellingTaken(text, clash.brandId);
    }
  }

  private async writeSpellings(
    executor: DbExecutor,
    brandId: string,
    spellings: Spellings,
  ): Promise<void> {
    await executor.insert(brandSpelling).values([
      { brandId, text: spellings.name, key: spellingKey(spellings.name), isName: true },
      ...spellings.aliases.map((text) => ({
        brandId,
        text,
        key: spellingKey(text),
        isName: false,
      })),
    ]);
  }

  /**
   * Two brands given one spelling at once: the unique key refuses the
   * second, which is then answered like the check before it.
   */
  private async guardSpellings<T>(
    texts: readonly string[],
    selfId: string | undefined,
    work: () => Promise<T>,
  ): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (!uniqueViolation(error, "brand_spelling_key_key")) {
        throw error;
      }
      await this.assertSpellingsFree(this.database.db, texts, selfId);
      throw error;
    }
  }
}
