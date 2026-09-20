import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  auditActions,
  auditEntities,
  type AdminAttribute,
  type AdminCatalogItem,
  type AdminCatalogItemCard,
  type AdminCatalogItemPage,
  type AttributeValue,
  type CatalogItemListQuery,
  type CatalogItemStatus,
  type CatalogItemType,
  type CatalogValueRejection,
  type CategoryFillPage,
  type CategoryFillQuery,
  type CategoryFillRow,
  type CreateCatalogItemBody,
  type FillCategoryBody,
  type FillCategoryResponse,
  type ItemValueInput,
  type SetItemValuesBody,
  type UpdateCatalogItemBody,
} from "@adclub/contracts";
import { normalizeArticle } from "@adclub/domain";
import { and, asc, count, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { DatabaseService, type DbExecutor } from "../../database";
import { AuditLog } from "../audit";
import { CatalogAdminService, type CatalogActor } from "./catalog-admin.service";
import { CatalogBrandsService } from "./catalog-brands.service";
import { CatalogPhotosService } from "./catalog-photos.service";
import {
  analogInvalid,
  brandArchived,
  categoryArchived,
  itemDuplicate,
  itemHasAnalogs,
  itemTypeImmutable,
  kindMismatch,
  notFound,
  notSubcategory,
  uniqueRace,
  validationError,
  valuesRejected,
  versionConflict,
} from "./catalog-errors";
import { productIdentityLock, STRUCTURE_LOCK_SHARED } from "./catalog-locks";
import {
  decodeCursor,
  encodeCursor,
  escapeLike,
  TIME_POSITION,
  UNIQUE_RACE_ATTEMPTS,
  uniqueViolation,
} from "./catalog-paging";
import {
  describeTexts,
  loadTexts,
  mergeTexts,
  normalizeText,
  plainTexts,
  textsOf,
} from "./catalog-texts";
import { checkValue, journalValue, sameValue, valueOf, type StoredColumns } from "./catalog-values";
import { refreshItemsCompleteness } from "./completeness";
import { sameProductItemIds } from "./same-products";
import { TranslationQueue } from "./translation-queue.service";
import {
  attribute,
  attributeOption,
  brand,
  catalogItem,
  category,
  itemAnalog,
  itemAttributeValue,
  type AttributeOptionRow,
  type AttributeRow,
  type CatalogItemRow,
  type CategoryRow,
  type ItemAttributeValueRow,
} from "./schema";

type Names = { kk: string | null; ru: string | null; en: string | null };

const NO_TEXTS: Names = { kk: null, ru: null, en: null };

/** The position of an item in the admin lists: its creation time to the microsecond. */
const createdPosition = sql<string>`to_char(${catalogItem.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** One value asked for: of an item's card (`previous` absent) or a cell of the fill (`previous` read). */
interface ValueRequest {
  index: number;
  itemId: string;
  attributeId: string;
  value: AttributeValue;
  previous?: AttributeValue;
}

/** A value that changes. */
interface ValueChange {
  index: number;
  item: CatalogItemRow;
  attribute: AttributeRow;
  columns: StoredColumns | null;
  before: AttributeValue;
  after: AttributeValue;
}

/**
 * Whether a value of the attribute is part of a product's identity: an
 * active attribute that counts for completeness (TASK-011 requirement 2).
 * Only a change of the identity is checked against the other products
 * (TASK-011.A): a pair that became the same when the structure changed
 * does not block the rest of the item.
 */
function identifies(entry: AttributeRow): boolean {
  return entry.status === "active" && entry.isRequiredForComplete;
}

/** The attributes of a category with their options, for checking values. */
interface AttributeBook {
  byId: Map<string, AttributeRow>;
  options: Map<string, AttributeOptionRow[]>;
  optionById: Map<string, AttributeOptionRow>;
}

function iso(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

function kindFor(type: CatalogItemType): "goods" | "services" {
  return type === "service" ? "services" : "goods";
}

/**
 * Items of the catalog for the administrator (TASK-011; ARCHITECTURE 4.17;
 * SCREENS A-CAT-03…A-CAT-05): parts, products and services — create,
 * change, draft/activate/archive (no deletion), attribute values one by one
 * and in bulk, analogs, and the searchable list. Every change is one
 * transaction with its entry in the action journal and keeps
 * `completeness` true to the data.
 */
@Injectable()
export class CatalogItemsService {
  private readonly logger = new Logger("Catalog");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditLog) private readonly audit: AuditLog,
    @Inject(CatalogAdminService) private readonly structure: CatalogAdminService,
    @Inject(CatalogBrandsService) private readonly brands: CatalogBrandsService,
    @Inject(CatalogPhotosService) private readonly photos: CatalogPhotosService,
    @Inject(TranslationQueue) private readonly translations: TranslationQueue,
  ) {}

  // ---------------------------------------------------------------- reads

  async page(query: CatalogItemListQuery): Promise<AdminCatalogItemPage> {
    const filters: (SQL | undefined)[] = [
      query.categoryId ? eq(catalogItem.categoryId, query.categoryId) : undefined,
      query.brandId ? eq(catalogItem.brandId, query.brandId) : undefined,
      query.type ? eq(catalogItem.itemType, query.type) : undefined,
      query.status ? eq(catalogItem.status, query.status) : undefined,
      query.completeness ? eq(catalogItem.completeness, query.completeness) : undefined,
      query.q ? this.searchCondition(query.q) : undefined,
      query.sameProduct === "matching"
        ? sql`${catalogItem.id} IN (${sameProductItemIds(query.categoryId)})`
        : undefined,
    ];
    return this.pageOf(filters, query.limit, query.cursor);
  }

  async card(
    itemId: string,
    executor: DbExecutor = this.database.db,
  ): Promise<AdminCatalogItemCard> {
    const row = await this.findItem(executor, itemId);
    const [[item], { category: described, attributes }] = await Promise.all([
      this.describeItems(executor, [row]),
      this.structure.attributes(row.categoryId, executor),
    ]);
    const active = attributes.filter((entry) => entry.status === "active");
    const stored = await this.valuesOf(executor, [row.id]);
    const own = stored.get(row.id) ?? new Map<string, ItemAttributeValueRow>();
    const photos = await this.photos.adminPhotosFor(executor, row.id);
    const links = await executor
      .select()
      .from(itemAnalog)
      .where(or(eq(itemAnalog.itemId, row.id), eq(itemAnalog.analogItemId, row.id)))
      .orderBy(desc(itemAnalog.createdAt));
    const otherIds = links.map((link) =>
      link.itemId === row.id ? link.analogItemId : link.itemId,
    );
    const others =
      otherIds.length === 0
        ? []
        : await executor.select().from(catalogItem).where(inArray(catalogItem.id, otherIds));
    const describedOthers = new Map(
      (await this.describeItems(executor, others)).map((entry) => [entry.id, entry]),
    );
    return {
      item: item!,
      category: described,
      attributes: active,
      values: active.map((entry) => {
        const value = own.get(entry.id);
        return {
          attributeId: entry.id,
          value: valueOf(value),
          source: value ? value.source : null,
          updatedAt: value ? value.updatedAt.toISOString() : null,
        };
      }),
      missingAttributeIds: active
        .filter((entry) => entry.isRequiredForComplete && !own.has(entry.id))
        .map((entry) => entry.id),
      analogs: links.map((link, index) => ({
        item: describedOthers.get(otherIds[index]!)!,
        status: link.status,
        source: link.source,
      })),
      photos,
    };
  }

  async fillPage(categoryId: string, query: CategoryFillQuery): Promise<CategoryFillPage> {
    const executor = this.database.db;
    const { category: described, attributes } = await this.structure.attributes(
      categoryId,
      executor,
    );
    if (described.level !== 2) {
      throw notSubcategory();
    }
    const active = attributes.filter((entry) => entry.status === "active");
    if (query.emptyAttributeId && !active.some((entry) => entry.id === query.emptyAttributeId)) {
      throw validationError("emptyAttributeId", "Not an active attribute of this category");
    }
    const filters: (SQL | undefined)[] = [
      eq(catalogItem.categoryId, categoryId),
      query.emptyAttributeId
        ? sql`NOT EXISTS (SELECT 1 FROM item_attribute_value v WHERE v.item_id = ${catalogItem.id} AND v.attribute_id = ${query.emptyAttributeId})`
        : undefined,
    ];
    const page = await this.pageOf(filters, query.limit, query.cursor);
    return {
      category: described,
      attributes: active,
      rows: await this.fillRows(executor, page.items, active),
      total: page.total,
      nextCursor: page.nextCursor,
    };
  }

  /** An item by its category and Russian name, for the development seed. */
  async findByRussianName(categoryId: string, name: string): Promise<CatalogItemRow | undefined> {
    const [row] = await this.database.db
      .select({ item: catalogItem })
      .from(catalogItem)
      .where(
        and(
          eq(catalogItem.categoryId, categoryId),
          sql`EXISTS (SELECT 1 FROM translation t WHERE t.entity_type = 'catalog_item' AND t.entity_id = ${catalogItem.id} AND t.field = 'name' AND t.lang = 'ru' AND t.text = ${normalizeText(name)})`,
        ),
      );
    return row?.item;
  }

  /** An item by its brand and article, for the development seed. */
  async findByArticle(brandId: string, article: string): Promise<CatalogItemRow | undefined> {
    const [row] = await this.database.db
      .select()
      .from(catalogItem)
      .where(
        and(
          eq(catalogItem.brandId, brandId),
          eq(catalogItem.articleNorm, normalizeArticle(article)),
        ),
      );
    return row;
  }

  // -------------------------------------------------------------- changes

  async create(input: CreateCatalogItemBody, actor: CatalogActor): Promise<AdminCatalogItemCard> {
    const type = input.type;
    if (type === "service") {
      if (input.brandId) {
        throw validationError("brandId", "A service has no brand");
      }
      if (input.article) {
        throw validationError("article", "A service has no article");
      }
    } else if (!input.brandId) {
      throw validationError("brandId", "A part or a product needs a brand");
    }
    if (type === "part" && !input.article) {
      throw validationError("article", "A part needs the manufacturer's article");
    }
    const article = this.article(input.article ?? null);
    const brandId = input.brandId ?? null;

    return this.guardArticle(brandId, article, () =>
      this.database.db.transaction(async (tx) => {
        await tx.execute(STRUCTURE_LOCK_SHARED);
        if (type === "generic") {
          await tx.execute(productIdentityLock(input.categoryId));
        }
        const owner = await this.usableCategory(tx, input.categoryId, type);
        if (brandId) {
          await this.usableBrand(tx, brandId, undefined);
        }
        await this.assertArticleFree(tx, brandId, article, undefined);
        const names = mergeTexts(NO_TEXTS, input.names);
        const [row] = await tx
          .insert(catalogItem)
          .values({
            itemType: type,
            categoryId: owner.id,
            categoryKind: owner.kind,
            brandId,
            article: article?.text ?? null,
            articleNorm: article?.norm ?? null,
            status: input.status ?? "active",
          })
          .returning();
        const created = row!;
        await this.translations.writeTexts(tx, "catalog_item", created.id, "name", {}, names);
        const changes = await this.applyValueRequests(
          tx,
          owner.id,
          [created],
          (input.values ?? []).map((value, index) => ({ index, itemId: created.id, ...value })),
        );
        await this.assertNoSameProduct(tx, created);
        await refreshItemsCompleteness(tx, [created.id]);
        const card = await this.card(created.id, tx);
        await this.audit.record(
          {
            action: auditActions.catalogItemCreated,
            actor,
            entityType: auditEntities.catalogItem,
            entityId: created.id,
            after: {
              type,
              categoryId: owner.id,
              brandId,
              article: created.article,
              articleNorm: created.articleNorm,
              names,
              status: created.status,
              values: this.journalValues(changes, "after"),
            },
          },
          tx,
        );
        this.logger.log(`Item created item=${created.id} type=${type} category=${owner.id}`);
        return card;
      }),
    );
  }

  async update(
    itemId: string,
    input: UpdateCatalogItemBody,
    actor: CatalogActor,
  ): Promise<AdminCatalogItemCard> {
    const peek = await this.findItem(this.database.db, itemId);
    const article =
      input.article === undefined
        ? undefined
        : input.article === null
          ? null
          : this.article(input.article);
    return this.guardArticle(
      input.brandId === undefined ? peek.brandId : input.brandId,
      article === undefined ? (peek.article ? this.article(peek.article) : null) : article,
      () =>
        this.database.db.transaction(async (tx) => {
          await tx.execute(STRUCTURE_LOCK_SHARED);
          if (peek.itemType === "generic") {
            await this.lockProductIdentities(tx, [peek.categoryId, input.categoryId]);
          }
          const row = await this.lockItem(tx, itemId);
          if (row.version !== input.expectedVersion) {
            throw versionConflict(row.version);
          }
          if (input.type !== undefined && input.type !== row.itemType) {
            throw itemTypeImmutable();
          }
          const type = row.itemType;

          let categoryId = row.categoryId;
          if (input.categoryId !== undefined && input.categoryId !== row.categoryId) {
            await this.usableCategory(tx, input.categoryId, type);
            const [link] = await tx
              .select({ itemId: itemAnalog.itemId })
              .from(itemAnalog)
              .where(or(eq(itemAnalog.itemId, row.id), eq(itemAnalog.analogItemId, row.id)))
              .limit(1);
            if (link) {
              throw itemHasAnalogs();
            }
            categoryId = input.categoryId;
          }

          let brandId = row.brandId;
          if (input.brandId !== undefined && input.brandId !== row.brandId) {
            if (type === "service") {
              throw validationError("brandId", "A service has no brand");
            }
            if (input.brandId === null) {
              throw validationError("brandId", "A part or a product needs a brand");
            }
            await this.usableBrand(tx, input.brandId, row.brandId);
            brandId = input.brandId;
          }

          let articleText = row.article;
          let articleNorm = row.articleNorm;
          if (article !== undefined && (article?.text ?? null) !== row.article) {
            if (type === "service" && article !== null) {
              throw validationError("article", "A service has no article");
            }
            if (type === "part" && article === null) {
              throw validationError("article", "A part needs the manufacturer's article");
            }
            articleText = article?.text ?? null;
            articleNorm = article?.norm ?? null;
          }
          if (brandId !== row.brandId || articleNorm !== row.articleNorm) {
            await this.assertArticleFree(
              tx,
              brandId,
              articleNorm === null ? null : { text: articleText!, norm: articleNorm },
              row.id,
            );
          }

          const texts = await loadTexts(tx, "catalog_item", [row.id]);
          const currentNames = textsOf(texts, row.id, "name");
          const namesBefore = plainTexts(currentNames);
          const names = mergeTexts(namesBefore, input.names);

          const changedBefore: Record<string, unknown> = {};
          const changedAfter: Record<string, unknown> = {};
          const note = (field: string, was: unknown, now: unknown) => {
            if (JSON.stringify(was) !== JSON.stringify(now)) {
              changedBefore[field] = was;
              changedAfter[field] = now;
            }
          };
          note("categoryId", row.categoryId, categoryId);
          note("brandId", row.brandId, brandId);
          note("article", row.article, articleText);
          note("articleNorm", row.articleNorm, articleNorm);
          note("names", namesBefore, names);
          if (Object.keys(changedAfter).length === 0) {
            return this.card(row.id, tx);
          }

          const [updated] = await tx
            .update(catalogItem)
            .set({
              categoryId,
              brandId,
              article: articleText,
              articleNorm,
              version: row.version + 1,
              updatedAt: new Date(),
            })
            .where(eq(catalogItem.id, row.id))
            .returning();
          await this.translations.writeTexts(
            tx,
            "catalog_item",
            row.id,
            "name",
            currentNames,
            names,
          );
          if (categoryId !== row.categoryId || brandId !== row.brandId) {
            await this.assertNoSameProduct(tx, updated!);
          }
          if (categoryId !== row.categoryId) {
            await refreshItemsCompleteness(tx, [row.id]);
          }
          await this.audit.record(
            {
              action: auditActions.catalogItemChanged,
              actor,
              entityType: auditEntities.catalogItem,
              entityId: row.id,
              before: changedBefore,
              after: { ...changedAfter, version: updated!.version },
            },
            tx,
          );
          this.logger.log(
            `Item changed item=${row.id} fields=${Object.keys(changedAfter).join(",")} version=${updated!.version}`,
          );
          return this.card(row.id, tx);
        }),
    );
  }

  async setStatus(
    itemId: string,
    status: CatalogItemStatus,
    expectedVersion: number,
    actor: CatalogActor,
  ): Promise<AdminCatalogItemCard> {
    return this.database.db.transaction(async (tx) => {
      const row = await this.lockItem(tx, itemId);
      if (row.version !== expectedVersion) {
        throw versionConflict(row.version);
      }
      if (row.status === status) {
        return this.card(row.id, tx);
      }
      const [updated] = await tx
        .update(catalogItem)
        .set({
          status,
          archivedAt: status === "archived" ? new Date() : null,
          version: row.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(catalogItem.id, row.id))
        .returning();
      await this.audit.record(
        {
          action: auditActions.catalogItemStatusChanged,
          actor,
          entityType: auditEntities.catalogItem,
          entityId: row.id,
          before: { status: row.status },
          after: { status, version: updated!.version },
        },
        tx,
      );
      this.logger.log(`Item status item=${row.id} from=${row.status} to=${status}`);
      return this.card(row.id, tx);
    });
  }

  async setValues(
    itemId: string,
    input: SetItemValuesBody,
    actor: CatalogActor,
  ): Promise<AdminCatalogItemCard> {
    const peek = await this.findItem(this.database.db, itemId);
    return this.database.db.transaction(async (tx) => {
      await tx.execute(STRUCTURE_LOCK_SHARED);
      if (peek.itemType === "generic") {
        await this.lockProductIdentities(tx, [peek.categoryId]);
      }
      const row = await this.lockItem(tx, itemId);
      if (row.version !== input.expectedVersion) {
        throw versionConflict(row.version);
      }
      const changes = await this.applyValueRequests(
        tx,
        row.categoryId,
        [row],
        input.values.map((value: ItemValueInput, index) => ({ index, itemId: row.id, ...value })),
      );
      if (changes.length === 0) {
        return this.card(row.id, tx);
      }
      const [updated] = await tx
        .update(catalogItem)
        .set({ version: row.version + 1, updatedAt: new Date() })
        .where(eq(catalogItem.id, row.id))
        .returning();
      if (changes.some((change) => identifies(change.attribute))) {
        await this.assertNoSameProduct(tx, updated!);
      }
      await refreshItemsCompleteness(tx, [row.id]);
      await this.recordValues(tx, actor, row.id, changes, "item", updated!.version);
      return this.card(row.id, tx);
    });
  }

  async fill(
    categoryId: string,
    input: FillCategoryBody,
    actor: CatalogActor,
  ): Promise<FillCategoryResponse> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(STRUCTURE_LOCK_SHARED);
      await tx.execute(productIdentityLock(categoryId));
      const [owner] = await tx.select().from(category).where(eq(category.id, categoryId));
      if (!owner) {
        throw notFound("category");
      }
      if (owner.level !== 2) {
        throw notSubcategory();
      }
      const itemIds = [...new Set(input.cells.map((cell) => cell.itemId))].sort();
      const items = await tx
        .select()
        .from(catalogItem)
        .where(and(inArray(catalogItem.id, itemIds), eq(catalogItem.categoryId, categoryId)))
        .orderBy(asc(catalogItem.id))
        .for("update");
      const changes = await this.applyValueRequests(
        tx,
        categoryId,
        items,
        input.cells.map((cell, index) => ({ index, ...cell })),
      );
      const touched = [...new Set(changes.map((change) => change.item.id))];
      const rejections: CatalogValueRejection[] = [];
      for (const id of touched) {
        const [updated] = await tx
          .update(catalogItem)
          .set({ version: sql`${catalogItem.version} + 1`, updatedAt: new Date() })
          .where(eq(catalogItem.id, id))
          .returning();
        const own = changes.filter((change) => change.item.id === id);
        const identity = own.find((change) => identifies(change.attribute));
        const same = identity ? await this.sameProduct(tx, updated!) : null;
        if (identity && same) {
          rejections.push({
            index: identity.index,
            itemId: id,
            attributeId: identity.attribute.id,
            reason: "duplicate_item",
            message: "With these values the product is the same as another one",
            existingItemId: same,
          });
        }
        await this.recordValues(tx, actor, id, own, "fill", updated!.version);
      }
      if (rejections.length > 0) {
        throw valuesRejected(rejections);
      }
      await refreshItemsCompleteness(tx, touched);
      const { attributes } = await this.structure.attributes(categoryId, tx);
      const active = attributes.filter((entry) => entry.status === "active");
      const requestOrder = [...new Set(input.cells.map((cell) => cell.itemId))].filter((id) =>
        touched.includes(id),
      );
      const rows =
        requestOrder.length === 0
          ? []
          : await tx.select().from(catalogItem).where(inArray(catalogItem.id, requestOrder));
      const byId = new Map(rows.map((row) => [row.id, row]));
      const described = await this.describeItems(
        tx,
        requestOrder.map((id) => byId.get(id)!),
      );
      if (changes.length > 0) {
        this.logger.log(
          `Category filled category=${categoryId} cells=${changes.length} items=${touched.length}`,
        );
      }
      return {
        changedCells: changes.length,
        rows: await this.fillRows(tx, described, active),
      };
    });
  }

  async linkAnalog(
    itemId: string,
    analogItemId: string,
    actor: CatalogActor,
  ): Promise<AdminCatalogItemCard> {
    if (itemId === analogItemId) {
      throw analogInvalid("self");
    }
    return this.database.db.transaction(async (tx) => {
      const pair = await tx
        .select()
        .from(catalogItem)
        .where(inArray(catalogItem.id, [itemId, analogItemId]))
        .orderBy(asc(catalogItem.id))
        .for("update");
      const item = pair.find((row) => row.id === itemId);
      const analog = pair.find((row) => row.id === analogItemId);
      if (!item || !analog) {
        throw notFound("item");
      }
      if (item.itemType !== "part" || analog.itemType !== "part") {
        throw analogInvalid("not_part");
      }
      if (item.categoryId !== analog.categoryId) {
        throw analogInvalid("other_category");
      }
      if (item.status === "archived" || analog.status === "archived") {
        throw analogInvalid("archived");
      }
      const [low, high] = [itemId, analogItemId].sort() as [string, string];
      const [existing] = await tx
        .select()
        .from(itemAnalog)
        .where(and(eq(itemAnalog.itemId, low), eq(itemAnalog.analogItemId, high)));
      if (existing?.status === "approved") {
        return this.card(itemId, tx);
      }
      if (existing) {
        await tx
          .update(itemAnalog)
          .set({ status: "approved", updatedAt: new Date() })
          .where(and(eq(itemAnalog.itemId, low), eq(itemAnalog.analogItemId, high)));
      } else {
        await tx.insert(itemAnalog).values({
          itemId: low,
          analogItemId: high,
          categoryId: item.categoryId,
          status: "approved",
          source: "admin",
        });
      }
      await this.audit.record(
        {
          action: auditActions.catalogItemAnalogLinked,
          actor,
          entityType: auditEntities.catalogItem,
          entityId: itemId,
          before: existing ? { analogItemId, status: existing.status } : null,
          after: { analogItemId, status: "approved" },
        },
        tx,
      );
      this.logger.log(`Analogs linked item=${itemId} analog=${analogItemId}`);
      return this.card(itemId, tx);
    });
  }

  async unlinkAnalog(
    itemId: string,
    analogItemId: string,
    actor: CatalogActor,
  ): Promise<AdminCatalogItemCard> {
    return this.database.db.transaction(async (tx) => {
      await this.findItem(tx, itemId);
      const [low, high] = [itemId, analogItemId].sort() as [string, string];
      const [removed] = await tx
        .delete(itemAnalog)
        .where(and(eq(itemAnalog.itemId, low), eq(itemAnalog.analogItemId, high)))
        .returning();
      if (!removed) {
        throw notFound("analog link");
      }
      await this.audit.record(
        {
          action: auditActions.catalogItemAnalogUnlinked,
          actor,
          entityType: auditEntities.catalogItem,
          entityId: itemId,
          before: { analogItemId, status: removed.status },
          after: null,
        },
        tx,
      );
      this.logger.log(`Analogs unlinked item=${itemId} analog=${analogItemId}`);
      return this.card(itemId, tx);
    });
  }

  // ------------------------------------------------------------- values

  /**
   * Checks every value asked for and writes those that change, or writes
   * nothing and lists every refused one (TASK-011 requirements 3, 5).
   * `items` — the items the values may belong to (locked by the caller).
   */
  private async applyValueRequests(
    executor: DbExecutor,
    categoryId: string,
    items: readonly CatalogItemRow[],
    requests: readonly ValueRequest[],
  ): Promise<ValueChange[]> {
    if (requests.length === 0) {
      return [];
    }
    const book = await this.attributeBook(executor, categoryId);
    const byId = new Map(items.map((item) => [item.id, item]));
    const stored = await this.valuesOf(
      executor,
      items.map((item) => item.id),
    );
    const rejections: CatalogValueRejection[] = [];
    const changes: ValueChange[] = [];
    const seen = new Set<string>();
    const reject = (
      request: ValueRequest,
      reason: CatalogValueRejection["reason"],
      message: string,
      extra: Partial<CatalogValueRejection> = {},
    ) =>
      rejections.push({
        index: request.index,
        itemId: request.itemId,
        attributeId: request.attributeId,
        reason,
        message,
        ...extra,
      });

    for (const request of requests) {
      const cell = `${request.itemId}|${request.attributeId}`;
      if (seen.has(cell)) {
        reject(request, "repeated", "The same value is asked for twice in one request");
        continue;
      }
      seen.add(cell);
      const item = byId.get(request.itemId);
      if (!item || item.categoryId !== categoryId) {
        reject(request, "item_not_found", "No such item in this category");
        continue;
      }
      const target = book.byId.get(request.attributeId);
      if (!target) {
        reject(request, "attribute_not_found", "Not an attribute of the item's category");
        continue;
      }
      const current = valueOf(stored.get(item.id)?.get(target.id));
      if (request.previous !== undefined && !sameValue(request.previous, current)) {
        reject(request, "conflict", "Changed by someone else since it was read", {
          currentValue: current,
        });
        continue;
      }
      if (sameValue(request.value, current)) {
        continue;
      }
      const checked = checkValue(target, book.options.get(target.id) ?? [], request.value);
      if (!checked.ok) {
        reject(request, checked.reason, checked.message);
        continue;
      }
      changes.push({
        index: request.index,
        item,
        attribute: target,
        columns: checked.columns,
        before: current,
        after: checked.value,
      });
    }
    if (rejections.length > 0) {
      throw valuesRejected(rejections);
    }
    for (const change of changes) {
      if (change.columns === null) {
        await executor
          .delete(itemAttributeValue)
          .where(
            and(
              eq(itemAttributeValue.itemId, change.item.id),
              eq(itemAttributeValue.attributeId, change.attribute.id),
            ),
          );
        continue;
      }
      await executor
        .insert(itemAttributeValue)
        .values({
          itemId: change.item.id,
          attributeId: change.attribute.id,
          attributeValueType: change.attribute.valueType,
          ...change.columns,
          source: "admin",
        })
        .onConflictDoUpdate({
          target: [itemAttributeValue.itemId, itemAttributeValue.attributeId],
          set: { ...change.columns, source: "admin", updatedAt: new Date() },
        });
    }
    return changes.map((change) => ({
      ...change,
      before: journalValue(change.before, book.optionById),
      after: journalValue(change.after, book.optionById),
    }));
  }

  private async attributeBook(executor: DbExecutor, categoryId: string): Promise<AttributeBook> {
    const attributes = await executor
      .select()
      .from(attribute)
      .where(eq(attribute.categoryId, categoryId));
    const options =
      attributes.length === 0
        ? []
        : await executor
            .select()
            .from(attributeOption)
            .where(
              inArray(
                attributeOption.attributeId,
                attributes.map((row) => row.id),
              ),
            );
    const grouped = new Map<string, AttributeOptionRow[]>();
    for (const option of options) {
      grouped.set(option.attributeId, [...(grouped.get(option.attributeId) ?? []), option]);
    }
    return {
      byId: new Map(attributes.map((row) => [row.id, row])),
      options: grouped,
      optionById: new Map(options.map((row) => [row.id, row])),
    };
  }

  private async valuesOf(
    executor: DbExecutor,
    itemIds: readonly string[],
  ): Promise<Map<string, Map<string, ItemAttributeValueRow>>> {
    const result = new Map<string, Map<string, ItemAttributeValueRow>>();
    if (itemIds.length === 0) {
      return result;
    }
    const rows = await executor
      .select()
      .from(itemAttributeValue)
      .where(inArray(itemAttributeValue.itemId, [...itemIds]));
    for (const row of rows) {
      const own = result.get(row.itemId) ?? new Map<string, ItemAttributeValueRow>();
      own.set(row.attributeId, row);
      result.set(row.itemId, own);
    }
    return result;
  }

  private journalValues(
    changes: readonly ValueChange[],
    side: "before" | "after",
  ): Record<string, AttributeValue> {
    return Object.fromEntries(changes.map((change) => [change.attribute.code, change[side]]));
  }

  private async recordValues(
    executor: DbExecutor,
    actor: CatalogActor,
    itemId: string,
    changes: readonly ValueChange[],
    via: "item" | "fill",
    version: number,
  ): Promise<void> {
    await this.audit.record(
      {
        action: auditActions.catalogItemValuesChanged,
        actor,
        entityType: auditEntities.catalogItem,
        entityId: itemId,
        before: { values: this.journalValues(changes, "before") },
        after: { values: this.journalValues(changes, "after"), via, version },
      },
      executor,
    );
  }

  // ---------------------------------------------------------- uniqueness

  /**
   * Another product (`generic`) of the same brand in the same category
   * whose every identifying value — of each active attribute that counts
   * for completeness — is filled and the same (TASK-011 requirement 2).
   * An empty identifying value is never «the same»; a category without such
   * attributes identifies nothing. Archived products count: restore one
   * rather than making it again.
   */
  private async sameProduct(executor: DbExecutor, item: CatalogItemRow): Promise<string | null> {
    if (item.itemType !== "generic" || !item.brandId) {
      return null;
    }
    const identifying = await executor
      .select({ id: attribute.id })
      .from(attribute)
      .where(
        and(
          eq(attribute.categoryId, item.categoryId),
          eq(attribute.status, "active"),
          eq(attribute.isRequiredForComplete, true),
        ),
      );
    if (identifying.length === 0) {
      return null;
    }
    const ids = identifying.map((row) => row.id);
    const own = await executor
      .select({ attributeId: itemAttributeValue.attributeId })
      .from(itemAttributeValue)
      .where(
        and(eq(itemAttributeValue.itemId, item.id), inArray(itemAttributeValue.attributeId, ids)),
      );
    if (own.length < ids.length) {
      return null;
    }
    const list = sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    const result = await executor.execute<{ id: string }>(sql`
      SELECT o.id FROM catalog_item o
      WHERE o.item_type = 'generic'
        AND o.category_id = ${item.categoryId}
        AND o.brand_id = ${item.brandId}
        AND o.id <> ${item.id}
        AND (
          SELECT count(*) FROM item_attribute_value v
          JOIN item_attribute_value s ON s.attribute_id = v.attribute_id AND s.item_id = ${item.id}
          WHERE v.item_id = o.id
            AND v.attribute_id IN (${list})
            AND v.value_num IS NOT DISTINCT FROM s.value_num
            AND v.value_option_id IS NOT DISTINCT FROM s.value_option_id
            AND v.value_bool IS NOT DISTINCT FROM s.value_bool
            AND lower(v.value_text) IS NOT DISTINCT FROM lower(s.value_text)
        ) = ${ids.length}
      ORDER BY o.created_at, o.id
      LIMIT 1`);
    return result.rows[0]?.id ?? null;
  }

  private async assertNoSameProduct(executor: DbExecutor, item: CatalogItemRow): Promise<void> {
    const same = await this.sameProduct(executor, item);
    if (same) {
      throw itemDuplicate(same);
    }
  }

  private async assertArticleFree(
    executor: DbExecutor,
    brandId: string | null,
    article: { text: string; norm: string } | null,
    selfId: string | undefined,
  ): Promise<void> {
    if (!brandId || !article) {
      return;
    }
    const existing = await this.itemWithArticle(executor, brandId, article.norm);
    if (existing && existing !== selfId) {
      throw itemDuplicate(existing);
    }
  }

  private async itemWithArticle(
    executor: DbExecutor,
    brandId: string,
    articleNorm: string,
  ): Promise<string | undefined> {
    const [row] = await executor
      .select({ id: catalogItem.id })
      .from(catalogItem)
      .where(and(eq(catalogItem.brandId, brandId), eq(catalogItem.articleNorm, articleNorm)));
    return row?.id;
  }

  /**
   * Two requests for one article of one brand at once: both pass the check,
   * the unique index lets one in and refuses the other, which is answered
   * with the item that got in (TASK-011 AC-3). If that item no longer has
   * the article (the other change was rolled back or changed it again), the
   * work is done once more; a second such clash is a 409 all the same,
   * never a 500 (TASK-011.A).
   */
  private async guardArticle<T>(
    brandId: string | null,
    article: { text: string; norm: string } | null,
    work: () => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await work();
      } catch (error) {
        if (!uniqueViolation(error, "catalog_item_brand_article_key")) {
          throw error;
        }
        const existing =
          brandId && article
            ? await this.itemWithArticle(this.database.db, brandId, article.norm)
            : undefined;
        if (existing) {
          throw itemDuplicate(existing);
        }
        if (attempt >= UNIQUE_RACE_ATTEMPTS) {
          throw uniqueRace();
        }
      }
    }
  }

  // -------------------------------------------------------------- helpers

  private article(text: string | null): { text: string; norm: string } | null {
    if (text === null) {
      return null;
    }
    const entered = normalizeText(text);
    const norm = normalizeArticle(entered);
    if (norm === "") {
      throw validationError("article", "An article needs at least one letter or digit");
    }
    return { text: entered, norm };
  }

  /** `q`: a part of the normalized article, or a part of a name in any language, case ignored. */
  private searchCondition(q: string): SQL {
    const article = normalizeArticle(q);
    const pattern = `%${escapeLike(normalizeText(q))}%`;
    const byName = sql`EXISTS (SELECT 1 FROM translation t WHERE t.entity_type = 'catalog_item' AND t.entity_id = ${catalogItem.id} AND t.field = 'name' AND lower(t.text) LIKE lower(${pattern}) ESCAPE '\\')`;
    return article === ""
      ? byName
      : sql`(strpos(${catalogItem.articleNorm}, ${article}) > 0 OR ${byName})`;
  }

  private async pageOf(
    filters: readonly (SQL | undefined)[],
    limit: number,
    cursor: string | undefined,
  ): Promise<AdminCatalogItemPage> {
    const executor = this.database.db;
    const after = cursor ? decodeCursor(cursor) : undefined;
    if (after && !TIME_POSITION.test(after.position)) {
      throw validationError("cursor", "Use the nextCursor of the previous page");
    }
    const [rows, [total]] = await Promise.all([
      executor
        .select({ item: catalogItem, position: createdPosition })
        .from(catalogItem)
        .where(
          and(
            ...filters,
            after
              ? sql`(${catalogItem.createdAt}, ${catalogItem.id}) < (${after.position}::timestamptz, ${after.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(catalogItem.createdAt), desc(catalogItem.id))
        .limit(limit + 1),
      executor
        .select({ value: count() })
        .from(catalogItem)
        .where(and(...filters)),
    ]);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: await this.describeItems(
        executor,
        page.map((row) => row.item),
      ),
      total: total?.value ?? 0,
      nextCursor: rows.length > limit && last ? encodeCursor(last.position, last.item.id) : null,
    };
  }

  private async fillRows(
    executor: DbExecutor,
    items: readonly AdminCatalogItem[],
    active: readonly AdminAttribute[],
  ): Promise<CategoryFillRow[]> {
    const stored = await this.valuesOf(
      executor,
      items.map((item) => item.id),
    );
    return items.map((item) => ({
      item,
      values: active.map((entry) => ({
        attributeId: entry.id,
        value: valueOf(stored.get(item.id)?.get(entry.id)),
      })),
    }));
  }

  async describeItems(
    executor: DbExecutor,
    rows: readonly CatalogItemRow[],
  ): Promise<AdminCatalogItem[]> {
    if (rows.length === 0) {
      return [];
    }
    const brandIds = [...new Set(rows.flatMap((row) => (row.brandId ? [row.brandId] : [])))];
    const [texts, brandRows, images] = await Promise.all([
      loadTexts(
        executor,
        "catalog_item",
        rows.map((row) => row.id),
      ),
      brandIds.length === 0
        ? Promise.resolve([])
        : executor.select().from(brand).where(inArray(brand.id, brandIds)),
      // The approved primary photo, in the mode `photo_display_mode` asks
      // for and never full-size (TASK-013 requirement 4).
      this.photos.imagesFor(executor, rows),
    ]);
    const brands = new Map(
      (await this.brands.describeMany(executor, brandRows)).map((entry) => [entry.id, entry]),
    );
    return rows.map((row) => {
      const owner = row.brandId ? brands.get(row.brandId) : undefined;
      return {
        id: row.id,
        type: row.itemType,
        categoryId: row.categoryId,
        brand: owner
          ? { id: owner.id, name: owner.name, isOem: owner.isOem, status: owner.status }
          : null,
        article: row.article,
        articleNorm: row.articleNorm,
        names: describeTexts(textsOf(texts, row.id, "name")),
        status: row.status,
        completeness: row.completeness,
        version: row.version,
        photo: images.get(row.id) ?? null,
        archivedAt: iso(row.archivedAt),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  }

  private async findItem(executor: DbExecutor, itemId: string): Promise<CatalogItemRow> {
    const [row] = await executor.select().from(catalogItem).where(eq(catalogItem.id, itemId));
    if (!row) {
      throw notFound("item");
    }
    return row;
  }

  private async lockItem(executor: DbExecutor, itemId: string): Promise<CatalogItemRow> {
    const [row] = await executor
      .select()
      .from(catalogItem)
      .where(eq(catalogItem.id, itemId))
      .for("update");
    if (!row) {
      throw notFound("item");
    }
    return row;
  }

  private async lockProductIdentities(
    executor: DbExecutor,
    categoryIds: readonly (string | undefined)[],
  ): Promise<void> {
    const ids = [...new Set(categoryIds.filter((id): id is string => id !== undefined))].sort();
    for (const id of ids) {
      await executor.execute(productIdentityLock(id));
    }
  }

  /**
   * The subcategory an item of `type` may be placed in: the second level,
   * of the item's kind, neither it nor its node archived (hidden is fine).
   */
  private async usableCategory(
    executor: DbExecutor,
    categoryId: string,
    type: CatalogItemType,
  ): Promise<CategoryRow> {
    const [row] = await executor.select().from(category).where(eq(category.id, categoryId));
    if (!row) {
      throw notFound("category");
    }
    if (row.level !== 2) {
      throw notSubcategory();
    }
    if (row.kind !== kindFor(type)) {
      throw kindMismatch();
    }
    const [parent] = row.parentId
      ? await executor.select().from(category).where(eq(category.id, row.parentId))
      : [];
    if (row.status === "archived" || parent?.status === "archived") {
      throw categoryArchived();
    }
    return row;
  }

  /** An active brand, or the one the item has already (`kept`), locked against archiving meanwhile. */
  private async usableBrand(
    executor: DbExecutor,
    brandId: string,
    kept: string | null | undefined,
  ): Promise<void> {
    const [row] = await executor.select().from(brand).where(eq(brand.id, brandId)).for("share");
    if (!row) {
      throw notFound("brand");
    }
    if (row.status === "archived" && brandId !== kept) {
      throw brandArchived();
    }
  }
}
