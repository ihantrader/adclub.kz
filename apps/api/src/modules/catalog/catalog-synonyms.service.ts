import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  auditActions,
  auditEntities,
  type AddSearchSynonymBody,
  type CatalogSynonymExistsDetails,
  type SearchSynonymList,
} from "@adclub/contracts";
import { asc, eq, sql } from "drizzle-orm";
import { ApiException } from "../../common/errors";
import { DatabaseService, type DbExecutor } from "../../database";
import { AuditLog } from "../audit";
import type { CatalogActor } from "./catalog-admin.service";
import { notFound } from "./catalog-errors";
import { normalizeText } from "./catalog-texts";
import { catalogItem, category, itemSearchSynonym, type ItemSearchSynonymRow } from "./schema";

type Owner = { kind: "item"; id: string } | { kind: "category"; id: string };

function ownerColumn(owner: Owner) {
  return owner.kind === "item" ? itemSearchSynonym.itemId : itemSearchSynonym.categoryId;
}

function synonymExists(existingSynonymId: string): ApiException {
  const details: CatalogSynonymExistsDetails = { existingSynonymId };
  return new ApiException(
    409,
    "CATALOG_SYNONYM_EXISTS",
    "It already has a synonym that reads the same (case, ё, Kazakh letters and signs ignored)",
    { details },
  );
}

/**
 * Search synonyms of items and categories (TASK-044 requirement 2;
 * ARCHITECTURE 10.2 п. 4, 4.64): a plain list per owner — add, remove — with
 * the action journal in the same transaction (the entity is the item or the
 * category, so a synonym shows in its history). Two synonyms of one owner
 * never read the same: the database's unique key on `search_key(term)` says
 * so, whoever writes at once.
 */
@Injectable()
export class CatalogSynonymsService {
  private readonly logger = new Logger(CatalogSynonymsService.name);

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditLog) private readonly audit: AuditLog,
  ) {}

  async list(owner: Owner): Promise<SearchSynonymList> {
    await this.findOwner(this.database.db, owner);
    return this.listOf(this.database.db, owner);
  }

  async add(
    owner: Owner,
    body: AddSearchSynonymBody,
    actor: CatalogActor,
  ): Promise<SearchSynonymList> {
    const term = normalizeText(body.term);
    const lang = body.lang ?? null;
    return this.database.db.transaction(async (tx) => {
      await this.findOwner(tx, owner, true);
      const [key] = await tx
        .execute<{ key: string }>(sql`SELECT search_key(${term}) AS key`)
        .then((result) => result.rows);
      if (!key || key.key === "") {
        throw new ApiException(400, "VALIDATION_ERROR", "A synonym needs a letter or a digit", {
          details: [{ path: "term", message: "A synonym needs a letter or a digit" }],
        });
      }
      // The owner's row is locked: two administrators adding the same synonym
      // at once — the second sees the first's.
      const [existing] = await tx
        .select({ id: itemSearchSynonym.id })
        .from(itemSearchSynonym)
        .where(
          sql`${ownerColumn(owner)} = ${owner.id} AND ${itemSearchSynonym.termKey} = ${key.key}`,
        );
      if (existing) {
        throw synonymExists(existing.id);
      }
      await tx.insert(itemSearchSynonym).values({
        ...(owner.kind === "item" ? { itemId: owner.id } : { categoryId: owner.id }),
        term,
        lang,
      });
      await this.audit.record(
        {
          action: auditActions.catalogSynonymAdded,
          actor,
          entityType:
            owner.kind === "item" ? auditEntities.catalogItem : auditEntities.catalogCategory,
          entityId: owner.id,
          before: null,
          after: { term, lang },
        },
        tx,
      );
      this.logger.log(`Search synonym added ${owner.kind}=${owner.id}`);
      return this.listOf(tx, owner);
    });
  }

  async remove(synonymId: string, actor: CatalogActor): Promise<SearchSynonymList> {
    return this.database.db.transaction(async (tx) => {
      const [removed] = await tx
        .delete(itemSearchSynonym)
        .where(eq(itemSearchSynonym.id, synonymId))
        .returning();
      if (!removed) {
        throw notFound("synonym");
      }
      const owner: Owner = removed.itemId
        ? { kind: "item", id: removed.itemId }
        : { kind: "category", id: removed.categoryId! };
      await this.audit.record(
        {
          action: auditActions.catalogSynonymRemoved,
          actor,
          entityType:
            owner.kind === "item" ? auditEntities.catalogItem : auditEntities.catalogCategory,
          entityId: owner.id,
          before: { term: removed.term, lang: removed.lang },
          after: null,
        },
        tx,
      );
      this.logger.log(`Search synonym removed ${owner.kind}=${owner.id}`);
      return this.listOf(tx, owner);
    });
  }

  /** The synonyms of an owner as their terms (the dev seed: what is already there). */
  async termsOf(owner: Owner): Promise<string[]> {
    const rows = await this.database.db
      .select({ term: itemSearchSynonym.term })
      .from(itemSearchSynonym)
      .where(eq(ownerColumn(owner), owner.id));
    return rows.map((row) => row.term);
  }

  private async findOwner(executor: DbExecutor, owner: Owner, lock = false): Promise<void> {
    const table = owner.kind === "item" ? catalogItem : category;
    const query = executor.select({ id: table.id }).from(table).where(eq(table.id, owner.id));
    const [row] = lock ? await query.for("update") : await query;
    if (!row) {
      throw notFound(owner.kind === "item" ? "item" : "category");
    }
  }

  private async listOf(executor: DbExecutor, owner: Owner): Promise<SearchSynonymList> {
    const rows: ItemSearchSynonymRow[] = await executor
      .select()
      .from(itemSearchSynonym)
      .where(eq(ownerColumn(owner), owner.id))
      .orderBy(asc(itemSearchSynonym.createdAt), asc(itemSearchSynonym.id));
    return {
      synonyms: rows.map((row) => ({
        id: row.id,
        term: row.term,
        lang: row.lang,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }
}
