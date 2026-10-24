import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  auditActions,
  auditEntities,
  type AdminCatalogRequest,
  type AdminCatalogRequestListQuery,
  type AdminCatalogRequestPage,
  type AdminCatalogRequestResponse,
  type CatalogLanguage,
  type CatalogRequestConflictDetails,
  type CatalogRequestDecidedResponse,
  type CatalogRequestListQuery,
  type CreateItemFromRequestBody,
  type ItemFromRequestResponse,
  type LinkCatalogRequestBody,
  type RejectCatalogRequestBody,
  type CatalogRequestExistsDetails,
  type CreateCatalogRequestBody,
  type SupplierBrandSuggestions,
  type SupplierCatalogRequest,
  type SupplierCatalogRequestPage,
  type SupplierCatalogRequestResponse,
} from "@adclub/contracts";
import { normalizeArticle, priceRowKey, rankCandidates, searchWords } from "@adclub/domain";
import { and, count, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { ApiException, rateLimitedException } from "../../common/errors";
import { DatabaseService, type DbExecutor } from "../../database";
import { AuditLog } from "../audit";
import {
  CatalogItemsService,
  CatalogPhotosService,
  loadTexts,
  localize,
  spellingKey,
  textsOf,
  type CatalogActor,
} from "../catalog";
import { adminUser, supplier, supplierMember } from "../identity";
import { describeOfferItems, offer } from "../offers";
import { AppSettings } from "../settings";
import { moderationSeenAt } from "./moderation-seen";
import { validationError } from "./price-import-errors";
import {
  brandsBySpelling,
  itemsByArticles,
  itemsByIds,
  nameCandidate,
  searchCandidates,
  type MatchItem,
} from "./price-match-items";
import {
  catalogRequest,
  priceImport,
  type CatalogRequestPayload,
  type CatalogRequestRow,
} from "./schema";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How many look-alike items the card of a request shows. */
const SIMILAR = 5;
/** How many brands the suggestions of S-OFF-05 offer. */
const BRAND_SUGGESTIONS = 10;

function encodeCursor(row: CatalogRequestRow): string {
  return Buffer.from(JSON.stringify([row.createdAt.toISOString(), row.id]), "utf8").toString(
    "base64url",
  );
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      Array.isArray(value) &&
      typeof value[0] === "string" &&
      typeof value[1] === "string" &&
      UUID.test(value[1]) &&
      new Date(value[0]).toISOString() === value[0]
    ) {
      return { createdAt: value[0], id: value[1] };
    }
  } catch {
    // Falls through to the refusal.
  }
  throw validationError("cursor", "Use the nextCursor of the previous page");
}

/** `%`, `_` and `\` of a typed text match themselves in LIKE. */
function likeText(text: string): string {
  return `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * A text of the admin's search (TASK-080): a part of the row's name or
 * brand, any case; or a part of its article in any spelling (the article
 * is compared normalized, as the catalog keeps it).
 */
function requestTextFilter(q: string): SQL {
  const text = likeText(q.trim());
  const article = normalizeArticle(q);
  return sql`(${catalogRequest.payload}->>'name' ILIKE ${text} OR ${catalogRequest.payload}->>'brand' ILIKE ${text}${
    article ? sql` OR ${catalogRequest.payload}->>'articleNorm' LIKE ${likeText(article)}` : sql``
  })`;
}

/**
 * Requests to add an item to the catalog (TASK-047 requirement 5; SCREENS
 * A-MOD-01, S-MOD-01; ARCHITECTURE 4.67). A row of a price list the catalog
 * has no item for comes here when the price list is applied. The
 * administrator:
 * - «Создать позицию» — the item is created exactly as «Новая позиция»
 *   creates it (`CatalogItemsService.create`), and in the same transaction
 *   the request is approved with it and the company's article remembered
 *   for it (`supplier_sku_mapping`, confirmed by the administrator);
 * - «Это существующая позиция» — the same, with an item that exists;
 * - «Отклонить» — with a reason the supplier sees.
 * No offer is created from an approved request: the price in the old file
 * may be stale; the next price list of the company applies the row by
 * itself. Every decision carries the request's version (409 with who
 * decided it otherwise) and is journaled.
 */
@Injectable()
export class CatalogRequestsService {
  private readonly logger = new Logger("CatalogRequests");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditLog) private readonly audit: AuditLog,
    @Inject(CatalogItemsService) private readonly items: CatalogItemsService,
    @Inject(CatalogPhotosService) private readonly photos: CatalogPhotosService,
    @Inject(AppSettings) private readonly settings: AppSettings,
  ) {}

  /** Requests waiting, for the home screen (`GET /admin/catalog-requests?status=new`). */
  async waiting(): Promise<number> {
    const [row] = await this.database.db
      .select({ value: count() })
      .from(catalogRequest)
      .where(eq(catalogRequest.status, "new"));
    return row?.value ?? 0;
  }

  /**
   * The admin's list of requests (A-MOD-01): by status, company, upload, a
   * text of the row (TASK-080 — the name or brand by a part, the article in
   * any spelling) and «есть похожая позиция» (the article is an item already).
   */
  async adminPage(
    query: AdminCatalogRequestListQuery,
    lang: CatalogLanguage,
  ): Promise<AdminCatalogRequestPage> {
    const db = this.database.db;
    const after = query.cursor ? decodeCursor(query.cursor) : null;
    // The filters but the status: the counts of the status chips follow them (TASK-080).
    const others: (SQL | undefined)[] = [
      query.supplierId ? eq(catalogRequest.supplierId, query.supplierId) : undefined,
      query.importId ? eq(catalogRequest.importId, query.importId) : undefined,
      query.q ? requestTextFilter(query.q) : undefined,
      query.similar
        ? sql`EXISTS (SELECT 1 FROM catalog_item ci WHERE ci.article_norm = ${catalogRequest.payload}->>'articleNorm' AND ci.status <> 'archived')`
        : undefined,
    ];
    const bySupplier = and(...others);
    const filters: (SQL | undefined)[] = [
      ...others,
      query.status ? eq(catalogRequest.status, query.status) : undefined,
    ];
    const [rows, [total], statuses] = await Promise.all([
      db
        .select()
        .from(catalogRequest)
        .where(
          and(
            ...filters,
            after
              ? sql`(${catalogRequest.createdAt}, ${catalogRequest.id}) < (${after.createdAt}::timestamptz, ${after.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(catalogRequest.createdAt), desc(catalogRequest.id))
        .limit(query.limit + 1),
      db
        .select({ value: count() })
        .from(catalogRequest)
        .where(and(...filters)),
      db
        .select({ status: catalogRequest.status, value: count() })
        .from(catalogRequest)
        .where(bySupplier)
        .groupBy(catalogRequest.status),
    ]);
    const page = rows.slice(0, query.limit);
    const counts = { new: 0, approved: 0, rejected: 0 };
    for (const row of statuses) counts[row.status] = row.value;
    return {
      requests: await this.describeAdmin(db, page, lang),
      total: total?.value ?? 0,
      counts,
      nextCursor: rows.length > query.limit ? encodeCursor(page.at(-1)!) : null,
    };
  }

  async adminCard(requestId: string, lang: CatalogLanguage): Promise<AdminCatalogRequestResponse> {
    const db = this.database.db;
    const row = await this.find(db, requestId);
    const [request] = await this.describeAdmin(db, [row], lang);
    return { request: request!, similar: await this.similar(db, row, lang) };
  }

  /** «Создать позицию»: the item and the answer to the request, in one transaction. */
  async createItem(
    requestId: string,
    body: CreateItemFromRequestBody,
    actor: Extract<CatalogActor, { role: "admin" }>,
    lang: CatalogLanguage,
  ): Promise<ItemFromRequestResponse> {
    // Refused before the item is made, when the page is already stale.
    await this.assertOpen(this.database.db, requestId, body.expectedVersion, false);
    const card = await this.items.create(body.item, actor, async (tx, created) => {
      await this.approve(tx, requestId, body.expectedVersion, created.item.id, "created", actor);
    });
    const db = this.database.db;
    const [request] = await this.describeAdmin(db, [await this.find(db, requestId)], lang);
    return { request: request!, item: card };
  }

  /** «Это существующая позиция». */
  async link(
    requestId: string,
    body: LinkCatalogRequestBody,
    actor: Extract<CatalogActor, { role: "admin" }>,
    lang: CatalogLanguage,
  ): Promise<CatalogRequestDecidedResponse> {
    await this.database.db.transaction(async (tx) => {
      const items = await itemsByIds(tx, [body.itemId]);
      const item = items.get(body.itemId);
      if (!item || !item.available || item.itemType === "service") {
        throw validationError(
          "itemId",
          "Choose an active part or product of a visible subcategory: services aren't set from a price list",
        );
      }
      await tx.execute(sql`SELECT id FROM catalog_item WHERE id = ${body.itemId} FOR SHARE`);
      await this.approve(tx, requestId, body.expectedVersion, body.itemId, "existing", actor);
    });
    const db = this.database.db;
    const [request] = await this.describeAdmin(db, [await this.find(db, requestId)], lang);
    return { request: request! };
  }

  /** «Отклонить»: the reason is what the supplier sees. */
  async reject(
    requestId: string,
    body: RejectCatalogRequestBody,
    actor: Extract<CatalogActor, { role: "admin" }>,
    lang: CatalogLanguage,
  ): Promise<CatalogRequestDecidedResponse> {
    await this.database.db.transaction(async (tx) => {
      const row = await this.assertOpen(tx, requestId, body.expectedVersion, true);
      const now = new Date();
      await tx
        .update(catalogRequest)
        .set({
          status: "rejected",
          rejectReason: body.reason,
          decidedByAdminId: actor.adminId,
          // The database's clock, as «Модерация» compares it (`moderation_seen_at`).
          decidedAt: sql`now()`,
          version: row.version + 1,
          updatedAt: now,
        })
        .where(eq(catalogRequest.id, requestId));
      await this.audit.record(
        {
          action: auditActions.catalogRequestRejected,
          actor,
          entityType: auditEntities.catalogRequest,
          entityId: requestId,
          before: { status: "new" },
          after: { status: "rejected", supplierId: row.supplierId },
          reason: body.reason,
        },
        tx,
      );
    });
    this.logger.log(`Catalog request rejected request=${requestId}`);
    const db = this.database.db;
    const [request] = await this.describeAdmin(db, [await this.find(db, requestId)], lang);
    return { request: request! };
  }

  /**
   * The company's own requests (S-MOD-01), newest first, with «новое» for
   * this employee (decided after the moment they last opened «Модерация»)
   * and the company's offer on the item a request became («Выставить»).
   */
  async supplierPage(
    actor: { supplierId: string; memberId: string },
    query: CatalogRequestListQuery,
    lang: CatalogLanguage,
  ): Promise<SupplierCatalogRequestPage> {
    const db = this.database.db;
    const after = query.cursor ? decodeCursor(query.cursor) : null;
    const rows = await db
      .select()
      .from(catalogRequest)
      .where(
        and(
          eq(catalogRequest.supplierId, actor.supplierId),
          query.status ? eq(catalogRequest.status, query.status) : undefined,
          after
            ? sql`(${catalogRequest.createdAt}, ${catalogRequest.id}) < (${after.createdAt}::timestamptz, ${after.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(catalogRequest.createdAt), desc(catalogRequest.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    return {
      requests: await this.describeSupplier(db, actor, page, lang),
      nextCursor: rows.length > query.limit ? encodeCursor(page.at(-1)!) : null,
    };
  }

  /**
   * «Нет в справочнике? Отправьте запрос на добавление» (S-OFF-05): the same
   * request a row of a price list makes, by hand. One waiting request per
   * article (or name, without one) of the company — a second is refused
   * with the first one's id; `catalog_requests_per_supplier_day` a day for
   * the whole company.
   */
  async createManual(
    actor: { supplierId: string; memberId: string; accountId: string },
    body: CreateCatalogRequestBody,
    lang: CatalogLanguage,
  ): Promise<SupplierCatalogRequestResponse> {
    const db = this.database.db;
    const article = body.article ? normalizeArticle(body.article) : "";
    const key = priceRowKey({ articleNorm: article === "" ? null : article, name: body.name });
    if (!key) throw validationError("name", "Name the item");
    const payload: CatalogRequestPayload = {
      article: body.article ?? null,
      articleNorm: article === "" ? null : article,
      brand: body.brand ?? null,
      name: body.name,
      price: null,
      availability: null,
      leadDays: null,
    };
    const id = await db.transaction(async (tx) => {
      // One company at a time: the count of the day and the waiting key are checked together.
      await tx.execute(sql`SELECT id FROM supplier WHERE id = ${actor.supplierId} FOR UPDATE`);
      if (body.categoryId) await this.assertSubcategory(tx, body.categoryId);
      const [waiting] = await tx
        .select({ id: catalogRequest.id })
        .from(catalogRequest)
        .where(
          and(
            eq(catalogRequest.supplierId, actor.supplierId),
            eq(catalogRequest.keyKind, key.kind),
            eq(catalogRequest.key, key.key),
            eq(catalogRequest.status, "new"),
          ),
        );
      if (waiting) {
        const details: CatalogRequestExistsDetails = { requestId: waiting.id };
        throw new ApiException(
          409,
          "CATALOG_REQUEST_EXISTS",
          "The company already has a request on this item waiting for the administrator",
          { details },
        );
      }
      const limit = await this.settings.get("catalog_requests_per_supplier_day");
      const day = await tx.execute<{ sent: number; wait: number | null }>(sql`
        SELECT count(*)::int AS sent,
          extract(epoch FROM min(created_at) + interval '1 day' - now())::float AS wait
        FROM catalog_request
        WHERE supplier_id = ${actor.supplierId} AND source = 'manual'
          AND created_at > now() - interval '1 day'`);
      const counted = day.rows[0];
      if (counted && counted.sent >= limit) {
        throw rateLimitedException(
          "catalog_requests_per_supplier",
          Math.max(1, Math.ceil(Number(counted.wait ?? 86_400))),
        );
      }
      const [created] = await tx
        .insert(catalogRequest)
        .values({
          supplierId: actor.supplierId,
          source: "manual",
          keyKind: key.kind,
          key: key.key,
          payload,
          categoryId: body.categoryId ?? null,
          comment: body.comment ?? null,
          createdByMemberId: actor.memberId,
        })
        .returning({ id: catalogRequest.id });
      await this.audit.record(
        {
          action: auditActions.catalogRequestCreated,
          actor: { role: "supplier", ...actor },
          entityType: auditEntities.catalogRequest,
          entityId: created!.id,
          after: { source: "manual", name: body.name, article: body.article ?? null },
        },
        tx,
      );
      return created!.id;
    });
    this.logger.log(`Catalog request sent by hand request=${id} supplier=${actor.supplierId}`);
    const [request] = await this.describeSupplier(db, actor, [await this.find(db, id)], lang);
    return { request: request! };
  }

  /** Brands of the catalog by the beginning of any spelling (S-OFF-05 «подсказки»). */
  async brandSuggestions(q: string): Promise<SupplierBrandSuggestions> {
    const key = spellingKey(q);
    if (key === "") return { brands: [] };
    const rows = await this.database.db.execute<{ id: string; name: string; matched: string }>(sql`
      SELECT DISTINCT ON (b.id) b.id, n.text AS name, s.text AS matched
      FROM brand b
      JOIN brand_spelling s ON s.brand_id = b.id AND starts_with(s.key, ${key})
      JOIN brand_spelling n ON n.brand_id = b.id AND n.is_name
      WHERE b.status = 'active'
      ORDER BY b.id, s.is_name DESC
      LIMIT 50`);
    return {
      brands: rows.rows
        .sort((a, b) => a.name.localeCompare(b.name, "ru"))
        .slice(0, BRAND_SUGGESTIONS)
        .map((row) => ({ id: row.id, name: row.name, matched: row.matched })),
    };
  }

  // ------------------------------------------------------------- helpers

  /** Requests as the company sees them: the item, the company's offer on it, «новое». */
  private async describeSupplier(
    executor: DbExecutor,
    actor: { supplierId: string; memberId: string },
    rows: readonly CatalogRequestRow[],
    lang: CatalogLanguage,
  ): Promise<SupplierCatalogRequest[]> {
    if (rows.length === 0) return [];
    const itemIds = rows.flatMap((row) => (row.resultItemId ? [row.resultItemId] : []));
    const [items, offers, categories, seenAt] = await Promise.all([
      describeOfferItems(executor, this.photos, itemIds, lang),
      itemIds.length === 0
        ? Promise.resolve([])
        : executor
            .select({ itemId: offer.itemId, id: offer.id, status: offer.status })
            .from(offer)
            .where(and(eq(offer.supplierId, actor.supplierId), inArray(offer.itemId, itemIds))),
      this.categoryNames(executor, rows, lang),
      moderationSeenAt(executor, actor.memberId),
    ]);
    const offerOf = new Map(offers.map((row) => [row.itemId, row]));
    return rows.map((row) => {
      const own = row.resultItemId ? offerOf.get(row.resultItemId) : undefined;
      return {
        id: row.id,
        status: row.status,
        data: this.data(row),
        importId: row.importId,
        rowNo: row.rowNo,
        item: row.resultItemId ? (items.get(row.resultItemId) ?? null) : null,
        rejectReason: row.rejectReason,
        createdAt: row.createdAt.toISOString(),
        decidedAt: row.decidedAt?.toISOString() ?? null,
        source: row.source,
        category: row.categoryId ? (categories.get(row.categoryId) ?? null) : null,
        comment: row.comment,
        isNew: row.decidedAt !== null && row.decidedAt > seenAt,
        offer: own ? { id: own.id, status: own.status } : null,
      };
    });
  }

  /** The subcategories the requests name, in the language of the request (Russian as the fallback). */
  private async categoryNames(
    executor: DbExecutor,
    rows: readonly CatalogRequestRow[],
    lang: CatalogLanguage,
  ): Promise<Map<string, { id: string; name: string }>> {
    const ids = [...new Set(rows.flatMap((row) => (row.categoryId ? [row.categoryId] : [])))];
    if (ids.length === 0) return new Map();
    const texts = await loadTexts(executor, "category", ids);
    return new Map(
      ids.map((id) => [id, { id, name: localize(textsOf(texts, id, "name"), lang)?.text ?? "" }]),
    );
  }

  /** The subcategory a supplier suggests: an active category with a parent (two levels, 4.15). */
  private async assertSubcategory(executor: DbExecutor, categoryId: string): Promise<void> {
    const rows = await executor.execute<{ id: string }>(sql`
      SELECT c.id FROM category c JOIN category p ON p.id = c.parent_id
      WHERE c.id = ${categoryId} AND c.status = 'active' AND p.status = 'active'`);
    if (rows.rows.length === 0) {
      throw validationError("categoryId", "Choose an active subcategory of the catalog");
    }
  }

  /**
   * Approves the request with the item and remembers it for the company:
   * the next price list matches the row by itself (12.2), without AI and
   * without the review.
   */
  private async approve(
    tx: DbExecutor,
    requestId: string,
    expectedVersion: number,
    itemId: string,
    how: "created" | "existing",
    actor: Extract<CatalogActor, { role: "admin" }>,
  ): Promise<void> {
    const row = await this.assertOpen(tx, requestId, expectedVersion, true);
    const now = new Date();
    await tx
      .update(catalogRequest)
      .set({
        status: "approved",
        resultItemId: itemId,
        decidedByAdminId: actor.adminId,
        decidedAt: sql`now()`,
        version: row.version + 1,
        updatedAt: now,
      })
      .where(eq(catalogRequest.id, requestId));
    await tx.execute(sql`
      INSERT INTO supplier_sku_mapping (supplier_id, key_kind, key, decision, item_id, confirmed_by,
        confirmed_by_admin_id, import_id, confirmed_at)
      VALUES (${row.supplierId}, ${row.keyKind}, ${row.key}, 'item', ${itemId}, 'admin',
        ${actor.adminId}, ${row.importId}, ${now})
      ON CONFLICT (supplier_id, key_kind, key) DO UPDATE SET
        decision = 'item', item_id = excluded.item_id, confirmed_by = 'admin',
        confirmed_by_member_id = NULL, confirmed_by_admin_id = excluded.confirmed_by_admin_id,
        import_id = excluded.import_id, confirmed_at = excluded.confirmed_at, updated_at = ${now}`);
    await this.audit.record(
      {
        action: auditActions.catalogRequestApproved,
        actor,
        entityType: auditEntities.catalogRequest,
        entityId: requestId,
        before: { status: "new" },
        after: { status: "approved", itemId, how, supplierId: row.supplierId },
      },
      tx,
    );
    this.logger.log(`Catalog request approved request=${requestId} item=${itemId} how=${how}`);
  }

  /** The request still waiting, at the version the page decided on; else 409 with who decided it. */
  private async assertOpen(
    executor: DbExecutor,
    requestId: string,
    expectedVersion: number,
    lock: boolean,
  ): Promise<CatalogRequestRow> {
    const query = executor.select().from(catalogRequest).where(eq(catalogRequest.id, requestId));
    const [row] = lock ? await query.for("update") : await query;
    if (!row) throw new ApiException(404, "NOT_FOUND", "No such request");
    if (row.status !== "new" || row.version !== expectedVersion) {
      const details: CatalogRequestConflictDetails = {
        status: row.status,
        version: row.version,
        decidedBy: row.decidedByAdminId
          ? {
              adminId: row.decidedByAdminId,
              name: await this.adminName(executor, row.decidedByAdminId),
            }
          : null,
        decidedAt: row.decidedAt?.toISOString() ?? null,
      };
      throw new ApiException(
        409,
        "CATALOG_REQUEST_VERSION_CONFLICT",
        row.status === "new"
          ? "The request was changed by someone else meanwhile; reload it"
          : "The request has been decided already",
        { details },
      );
    }
    return row;
  }

  private async find(executor: DbExecutor, requestId: string): Promise<CatalogRequestRow> {
    const [row] = await executor
      .select()
      .from(catalogRequest)
      .where(eq(catalogRequest.id, requestId));
    if (!row) throw new ApiException(404, "NOT_FOUND", "No such request");
    return row;
  }

  private data(row: CatalogRequestRow) {
    const payload = row.payload;
    return {
      article: payload.article,
      brand: payload.brand,
      name: payload.name,
      price: payload.price,
      availability: payload.availability,
      leadDays: payload.leadDays,
    };
  }

  private async describeAdmin(
    executor: DbExecutor,
    rows: readonly CatalogRequestRow[],
    lang: CatalogLanguage,
  ): Promise<AdminCatalogRequest[]> {
    if (rows.length === 0) return [];
    const supplierIds = [...new Set(rows.map((row) => row.supplierId))];
    const memberIds = [
      ...new Set(rows.flatMap((row) => (row.createdByMemberId ? [row.createdByMemberId] : []))),
    ];
    const importIds = [...new Set(rows.flatMap((row) => (row.importId ? [row.importId] : [])))];
    const adminIds = [
      ...new Set(rows.flatMap((row) => (row.decidedByAdminId ? [row.decidedByAdminId] : []))),
    ];
    const [companies, members, imports, items, brands, admins] = await Promise.all([
      executor
        .select({ id: supplier.id, name: supplier.name })
        .from(supplier)
        .where(inArray(supplier.id, supplierIds)),
      memberIds.length === 0
        ? Promise.resolve([])
        : executor
            .select({ id: supplierMember.id, name: supplierMember.displayName })
            .from(supplierMember)
            .where(inArray(supplierMember.id, memberIds)),
      importIds.length === 0
        ? Promise.resolve([])
        : executor
            .select({
              id: priceImport.id,
              fileName: priceImport.fileName,
              createdAt: priceImport.createdAt,
            })
            .from(priceImport)
            .where(inArray(priceImport.id, importIds)),
      describeOfferItems(
        executor,
        this.photos,
        rows.flatMap((row) => (row.resultItemId ? [row.resultItemId] : [])),
        lang,
      ),
      brandsBySpelling(
        executor,
        rows.flatMap((row) => (row.payload.brand ? [row.payload.brand] : [])),
      ),
      Promise.all(adminIds.map(async (id) => [id, await this.adminName(executor, id)] as const)),
    ]);
    const companyName = new Map(companies.map((row) => [row.id, row.name]));
    const memberName = new Map(members.map((row) => [row.id, row.name]));
    const importOf = new Map(imports.map((row) => [row.id, row]));
    const adminName = new Map(admins);
    const brandIds = [...new Set([...brands.values()].flat())];
    const [brandNames, categories] = await Promise.all([
      this.brandNames(executor, brandIds),
      this.categoryNames(executor, rows, lang),
    ]);
    return rows.map((row) => {
      const imported = row.importId ? importOf.get(row.importId) : undefined;
      const brandId = row.payload.brand
        ? brands.get(spellingKey(row.payload.brand))?.[0]
        : undefined;
      return {
        id: row.id,
        status: row.status,
        version: row.version,
        supplier: { id: row.supplierId, name: companyName.get(row.supplierId) ?? "" },
        createdBy: row.createdByMemberId
          ? { memberId: row.createdByMemberId, name: memberName.get(row.createdByMemberId) ?? null }
          : null,
        data: this.data(row),
        brand: brandId ? { id: brandId, name: brandNames.get(brandId) ?? "" } : null,
        import: imported
          ? {
              id: imported.id,
              fileName: imported.fileName,
              rowNo: row.rowNo,
              createdAt: imported.createdAt.toISOString(),
            }
          : null,
        item: row.resultItemId ? (items.get(row.resultItemId) ?? null) : null,
        rejectReason: row.rejectReason,
        decidedBy: row.decidedByAdminId
          ? { adminId: row.decidedByAdminId, name: adminName.get(row.decidedByAdminId) ?? null }
          : null,
        decidedAt: row.decidedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        source: row.source,
        category: row.categoryId ? (categories.get(row.categoryId) ?? null) : null,
        comment: row.comment,
      };
    });
  }

  /** Items that look like the request: its article, then the search by its name. */
  private async similar(executor: DbExecutor, row: CatalogRequestRow, lang: CatalogLanguage) {
    const payload = row.payload;
    const byArticle: MatchItem[] = payload.articleNorm
      ? ((await itemsByArticles(executor, [payload.articleNorm])).get(payload.articleNorm) ?? [])
      : [];
    const words = searchWords({ name: payload.name, brand: payload.brand }, 3);
    const pool = words.length > 0 ? await searchCandidates(executor, words) : [];
    const ranked = rankCandidates(
      { name: payload.name, brand: payload.brand },
      pool.map(nameCandidate),
      SIMILAR,
    ).map((entry) => entry.candidate.itemId);
    const ids = [...new Set([...byArticle.map((item) => item.id), ...ranked])].slice(0, SIMILAR);
    const described = await describeOfferItems(executor, this.photos, ids, lang);
    return ids.flatMap((id) => {
      const item = described.get(id);
      return item ? [item] : [];
    });
  }

  private async brandNames(
    executor: DbExecutor,
    ids: readonly string[],
  ): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await executor.execute<{ brand_id: string; text: string }>(
      sql`SELECT brand_id, text FROM brand_spelling WHERE is_name AND brand_id = ANY(${`{${ids.join(",")}}`}::uuid[])`,
    );
    return new Map(rows.rows.map((row) => [row.brand_id, row.text]));
  }

  private async adminName(executor: DbExecutor, adminId: string): Promise<string | null> {
    const rows = await executor.execute<{ name: string | null }>(sql`
      SELECT a.name FROM ${adminUser} u JOIN account a ON a.id = u.account_id WHERE u.id = ${adminId}`);
    return rows.rows[0]?.name ?? null;
  }
}
