import { Inject, Injectable, Logger } from "@nestjs/common";
import type {
  CatalogLanguage,
  ChoosePriceMissingBody,
  DecidePriceRowBody,
  OfferItem,
  PriceImport,
  PriceImportItemUnavailableDetails,
  PriceImportStateDetails,
  PriceImportVersionBody,
  PriceImportVersionConflictDetails,
  PriceMissingPage,
  PriceMissingQuery,
  PriceReviewRow,
  PriceReviewRowsPage,
  PriceReviewRowsQuery,
  PriceReviewSummary,
  PriceRowDecidedResponse,
  PriceRowsSkippedResponse,
} from "@adclub/contracts";
import { sharpPriceChange } from "@adclub/domain";
import { and, asc, count, eq, gt, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { ApiException } from "../../common/errors";
import { DatabaseService, type DbExecutor } from "../../database";
import { JobQueue } from "../../jobs";
import { CatalogPhotosService } from "../catalog";
import { supplier, supplierMember } from "../identity";
import { describeOfferItems, offer } from "../offers";
import { AppSettings } from "../settings";
import { supplierLocation } from "../suppliers";
import { planNumbers, sendsRequest } from "./price-apply-plan";
import { notFound, validationError } from "./price-import-errors";
import { applyPriceImportJob } from "./price-import-jobs";
import { describeImport, rowErrors } from "./price-import-views";
import { itemRefusal, itemsByIds } from "./price-match-items";
import {
  loadPlan,
  missingOffersQuery,
  requestKeys,
  type MissingOfferRow,
} from "./price-review-data";
import type { PriceImportActor } from "./price-imports.service";
import {
  priceImport,
  priceImportRow,
  type PriceImportRecord,
  type PriceImportRowRecord,
  type PriceRowGroup,
} from "./schema";

const GROUP_OF = {
  confident: "confident",
  review: "review",
  not_found: "not_found",
  errors: "error",
} as const satisfies Record<PriceReviewRow["group"], PriceRowGroup>;

const CONTRACT_GROUP = {
  confident: "confident",
  review: "review",
  not_found: "not_found",
  error: "errors",
} as const satisfies Record<PriceRowGroup, PriceReviewRow["group"]>;

function badCursor(): ApiException {
  return validationError("cursor", "Use the nextCursor of the previous page");
}

function itemUnavailable(reason: PriceImportItemUnavailableDetails["reason"]): ApiException {
  const details: PriceImportItemUnavailableDetails = { reason };
  return new ApiException(
    409,
    "PRICE_IMPORT_ITEM_UNAVAILABLE",
    reason === "service_item"
      ? "Services are not set from a price list: their prices are set by model"
      : reason === "supplier_type"
        ? "The company's type doesn't let it sell this item"
        : "The item is not an active item of the catalog",
    { details },
  );
}

/**
 * The review of a matched price list in the cabinet (TASK-047 requirement
 * 3; SCREENS S-PRICE-03 — the screen comes with TASK-048): the summary
 * with the numbers of «Применить», the rows of a group, a decision on one
 * row at a time (AI's matches are never confirmed in bulk — the only bulk
 * action is «Пропустить все оставшиеся»), the one choice about the offers
 * missing in the file, and the request to apply. Every change carries the
 * import's version and bumps it, with who and when: a page that shows an
 * older state gets 409 with the colleague's name, nothing changes. Only
 * the company's own imports; another company's — 404.
 */
@Injectable()
export class PriceReviewService {
  private readonly logger = new Logger("PriceImports");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(JobQueue) private readonly queue: JobQueue,
    @Inject(CatalogPhotosService) private readonly photos: CatalogPhotosService,
  ) {}

  // ------------------------------------------------------------- reading

  async summary(supplierId: string, importId: string): Promise<PriceReviewSummary> {
    const db = this.database.db;
    const record = await this.own(db, supplierId, importId);
    const groups = { confident: 0, review: 0, notFound: 0, errors: 0 };
    const counted = await db
      .select({ group: priceImportRow.matchGroup, value: count() })
      .from(priceImportRow)
      .where(
        and(
          eq(priceImportRow.importId, importId),
          eq(priceImportRow.kind, "data"),
          isNotNull(priceImportRow.matchGroup),
        ),
      )
      .groupBy(priceImportRow.matchGroup);
    for (const row of counted) {
      if (row.group === "confident") groups.confident = row.value;
      if (row.group === "review") groups.review = row.value;
      if (row.group === "not_found") groups.notFound = row.value;
      if (row.group === "error") groups.errors = row.value;
    }
    const reviewing = record.status === "review" || record.status === "applying";
    const missing = reviewing
      ? await this.missingCounts(db, record)
      : { offers: 0, withActiveOrders: 0 };
    const numbers = reviewing
      ? planNumbers((await loadPlan(db, record, this.settings)).plans)
      : {
          update: 0,
          create: 0,
          withdraw: 0,
          request: 0,
          unchecked: 0,
          priceConfirmationRequired: 0,
        };
    const sharp = reviewing ? await this.sharpCounts(db, record) : { rows: 0, unconfirmed: 0 };
    const withdrawMissing = record.missingAction === "withdraw" ? missing.offers : 0;
    return {
      import: await this.describe(db, record),
      groups,
      missing: {
        offers: missing.offers,
        withActiveOrders: missing.withActiveOrders,
        action: record.missingAction,
        decidedBy: record.missingDecidedByMemberId
          ? {
              memberId: record.missingDecidedByMemberId,
              name: await this.memberName(db, record.missingDecidedByMemberId),
            }
          : null,
      },
      sharpPrice: sharp,
      preview: { ...numbers, withdraw: numbers.withdraw + withdrawMissing },
      canApply:
        record.status === "review" && (missing.offers === 0 || record.missingAction !== null),
    };
  }

  async rows(
    supplierId: string,
    importId: string,
    query: PriceReviewRowsQuery,
    lang: CatalogLanguage,
  ): Promise<PriceReviewRowsPage> {
    const db = this.database.db;
    await this.own(db, supplierId, importId);
    const after = query.cursor === undefined ? null : this.rowCursor(query.cursor);
    const filter: SQL[] = [
      eq(priceImportRow.importId, importId),
      eq(priceImportRow.kind, "data"),
      eq(priceImportRow.matchGroup, GROUP_OF[query.group]),
    ];
    if (query.decided === "true") filter.push(isNotNull(priceImportRow.decision));
    if (query.decided === "false") filter.push(isNull(priceImportRow.decision));
    if (query.notApplied) {
      filter.push(
        eq(priceImportRow.outcome, "not_applied"),
        eq(priceImportRow.outcomeReason, query.notApplied),
      );
    }
    const [rows, [total]] = await Promise.all([
      db
        .select()
        .from(priceImportRow)
        .where(and(...filter, after !== null ? gt(priceImportRow.rowNo, after) : undefined))
        .orderBy(asc(priceImportRow.rowNo))
        .limit(query.limit + 1),
      db
        .select({ value: count() })
        .from(priceImportRow)
        .where(and(...filter)),
    ]);
    const page = rows.slice(0, query.limit);
    return {
      rows: await this.describeRows(db, supplierId, page, lang),
      total: total?.value ?? 0,
      nextCursor: rows.length > query.limit ? String(page.at(-1)!.rowNo) : null,
    };
  }

  async missing(
    supplierId: string,
    importId: string,
    query: PriceMissingQuery,
    lang: CatalogLanguage,
  ): Promise<PriceMissingPage> {
    const db = this.database.db;
    const record = await this.own(db, supplierId, importId);
    const after = query.cursor ? this.missingCursor(query.cursor) : undefined;
    const [rows, counts] = await Promise.all([
      db.execute<MissingOfferRow>(missingOffersQuery(record, { limit: query.limit + 1, after })),
      this.missingCounts(db, record),
    ]);
    const page = rows.rows.slice(0, query.limit);
    const items = await describeOfferItems(
      db,
      this.photos,
      page.map((row) => row.item_id),
      lang,
    );
    const last = page.at(-1);
    return {
      offers: page.map((row) => ({
        offerId: row.id,
        item: items.get(row.item_id)!,
        price: row.price,
        availability: row.availability,
        supplierSku: row.supplier_sku,
        activeOrders: row.active_orders,
      })),
      total: counts.offers,
      nextCursor:
        rows.rows.length > query.limit && last
          ? Buffer.from(JSON.stringify([last.created_at, last.id]), "utf8").toString("base64url")
          : null,
    };
  }

  // ------------------------------------------------------------ changing

  async decide(
    importId: string,
    rowNo: number,
    body: DecidePriceRowBody,
    actor: PriceImportActor,
    lang: CatalogLanguage,
  ): Promise<PriceRowDecidedResponse> {
    const { record, row } = await this.database.db.transaction(async (tx) => {
      const record = await this.lockForReview(tx, actor, importId, body.expectedVersion);
      const [current] = await tx
        .select()
        .from(priceImportRow)
        .where(
          and(
            eq(priceImportRow.importId, importId),
            eq(priceImportRow.rowNo, rowNo),
            eq(priceImportRow.kind, "data"),
          ),
        )
        .for("update");
      if (!current) throw new ApiException(404, "NOT_FOUND", "No such row of the price list");
      if (current.matchGroup === "error" || current.matchGroup === null) {
        throw validationError("rowNo", "A row with an error is not applied: fix it in the file");
      }
      const changes: Partial<PriceImportRowRecord> = {};
      if (body.decision !== undefined) {
        if (body.decision === null) {
          Object.assign(changes, {
            decision: null,
            decisionItemId: null,
            decidedByMemberId: null,
            decidedAt: null,
          });
        } else {
          const itemId = await this.decisionItem(tx, actor.supplierId, current, body);
          Object.assign(changes, {
            decision: body.decision,
            decisionItemId: itemId,
            decidedByMemberId: actor.memberId,
            decidedAt: new Date(),
          });
        }
      }
      if (body.priceConfirmed !== undefined) changes.priceConfirmed = body.priceConfirmed;
      if (body.sendRequest !== undefined) changes.sendRequest = body.sendRequest;
      const [row] = await tx
        .update(priceImportRow)
        .set(changes)
        .where(and(eq(priceImportRow.importId, importId), eq(priceImportRow.rowNo, rowNo)))
        .returning();
      const updated = await this.bump(tx, record, actor);
      return { record: updated, row: row! };
    });
    const db = this.database.db;
    const [described] = await this.describeRows(db, actor.supplierId, [row], lang);
    return { import: await this.describe(db, record), row: described! };
  }

  /** «Пропустить все оставшиеся»: the only action on many rows, and only in «Нужно проверить». */
  async skipRemaining(
    importId: string,
    body: PriceImportVersionBody,
    actor: PriceImportActor,
  ): Promise<PriceRowsSkippedResponse> {
    const { record, skipped } = await this.database.db.transaction(async (tx) => {
      const record = await this.lockForReview(tx, actor, importId, body.expectedVersion);
      const skipped = await tx
        .update(priceImportRow)
        .set({
          decision: "skip",
          decisionItemId: null,
          decidedByMemberId: actor.memberId,
          decidedAt: new Date(),
        })
        .where(
          and(
            eq(priceImportRow.importId, importId),
            eq(priceImportRow.kind, "data"),
            eq(priceImportRow.matchGroup, "review"),
            isNull(priceImportRow.decision),
          ),
        )
        .returning({ rowNo: priceImportRow.rowNo });
      return { record: await this.bump(tx, record, actor), skipped: skipped.length };
    });
    return { import: await this.describe(this.database.db, record), skipped };
  }

  async chooseMissing(
    importId: string,
    body: ChoosePriceMissingBody,
    actor: PriceImportActor,
  ): Promise<PriceImport> {
    const record = await this.database.db.transaction(async (tx) => {
      const record = await this.lockForReview(tx, actor, importId, body.expectedVersion);
      return this.bump(tx, record, actor, {
        missingAction: body.action,
        missingDecidedByMemberId: actor.memberId,
        missingDecidedAt: new Date(),
      });
    });
    return this.describe(this.database.db, record);
  }

  /**
   * «Применить»: the import goes to `applying` and the job is queued in the
   * same transaction; the job applies it in one transaction. A second
   * request — a double click, another tab, a colleague — finds it applying
   * or applied and gets 409 with who did it. A blocked company can't apply
   * (403 `SUPPLIER_BLOCKED`); a paused one can (the showcase doesn't show it anyway).
   */
  async apply(
    importId: string,
    body: PriceImportVersionBody,
    actor: PriceImportActor,
  ): Promise<PriceImport> {
    const record = await this.database.db.transaction(async (tx) => {
      const [company] = await tx
        .select({ status: supplier.status })
        .from(supplier)
        .where(eq(supplier.id, actor.supplierId))
        .for("share");
      if (company?.status === "blocked") {
        throw new ApiException(
          403,
          "SUPPLIER_BLOCKED",
          "The company is blocked by the club administrator: a price list can't be applied until the blocking is lifted",
        );
      }
      const record = await this.lockForReview(tx, actor, importId, body.expectedVersion);
      const missing = await this.missingCounts(tx, record);
      if (missing.offers > 0 && record.missingAction === null) {
        throw new ApiException(
          409,
          "PRICE_IMPORT_MISSING_CHOICE",
          "Choose what to do with the offers missing in the file: withdraw them or keep them as they are",
          { details: { missing: missing.offers, withActiveOrders: missing.withActiveOrders } },
        );
      }
      const now = new Date();
      const applying = await this.bump(tx, record, actor, {
        status: "applying",
        appliedByMemberId: actor.memberId,
        appliedAt: now,
      });
      await this.queue.enqueue(applyPriceImportJob, { importId }, { tx });
      return applying;
    });
    this.logger.log(`Price list apply requested import=${importId} member=${actor.memberId}`);
    return this.describe(this.database.db, record);
  }

  // ------------------------------------------------------------- helpers

  private async own(
    executor: DbExecutor,
    supplierId: string,
    importId: string,
    lock = false,
  ): Promise<PriceImportRecord> {
    const query = executor
      .select()
      .from(priceImport)
      .where(and(eq(priceImport.id, importId), eq(priceImport.supplierId, supplierId)));
    const [record] = lock ? await query.for("update") : await query;
    if (!record) throw notFound();
    return record;
  }

  /**
   * The import locked for a change of the review: the company's own, in
   * `review`, at the version the page decided on. Applied or being applied —
   * `PRICE_IMPORT_STATE` with who applied it; another version —
   * `PRICE_IMPORT_VERSION_CONFLICT` with who changed it last.
   */
  private async lockForReview(
    tx: DbExecutor,
    actor: PriceImportActor,
    importId: string,
    expectedVersion: number,
  ): Promise<PriceImportRecord> {
    const record = await this.own(tx, actor.supplierId, importId, true);
    if (record.status !== "review") {
      const details: PriceImportStateDetails = {
        status: record.status,
        appliedBy: record.appliedByMemberId
          ? {
              memberId: record.appliedByMemberId,
              name: await this.memberName(tx, record.appliedByMemberId),
            }
          : null,
        appliedAt: record.appliedAt?.toISOString() ?? null,
      };
      throw new ApiException(
        409,
        "PRICE_IMPORT_STATE",
        record.status === "applying" || record.status === "applied"
          ? "The price list has been applied already"
          : "The price list is not being reviewed now",
        { details },
      );
    }
    if (record.version !== expectedVersion) {
      const details: PriceImportVersionConflictDetails = {
        status: record.status,
        version: record.version,
        confirmedBy: record.columnsConfirmedByMemberId
          ? {
              memberId: record.columnsConfirmedByMemberId,
              name: await this.memberName(tx, record.columnsConfirmedByMemberId),
            }
          : null,
        confirmedAt: record.columnsConfirmedAt?.toISOString() ?? null,
        changedBy: record.changedByMemberId
          ? {
              memberId: record.changedByMemberId,
              name: await this.memberName(tx, record.changedByMemberId),
            }
          : null,
        changedAt: record.changedAt?.toISOString() ?? null,
      };
      throw new ApiException(
        409,
        "PRICE_IMPORT_VERSION_CONFLICT",
        "The review was changed by someone else meanwhile; reload it and decide again",
        { details },
      );
    }
    return record;
  }

  private async bump(
    tx: DbExecutor,
    record: PriceImportRecord,
    actor: PriceImportActor,
    more: Partial<PriceImportRecord> = {},
  ): Promise<PriceImportRecord> {
    const now = new Date();
    const [updated] = await tx
      .update(priceImport)
      .set({
        ...more,
        version: record.version + 1,
        changedByMemberId: actor.memberId,
        changedAt: now,
        updatedAt: now,
      })
      .where(eq(priceImport.id, record.id))
      .returning();
    return updated!;
  }

  /**
   * The item of a decision: «Верно» — the proposed item or one of the
   * candidates; «Другая позиция» — any item the company may sell (the same
   * rules as a candidate: active, visible, goods of the company's type).
   */
  private async decisionItem(
    tx: DbExecutor,
    supplierId: string,
    row: PriceImportRowRecord,
    body: DecidePriceRowBody,
  ): Promise<string | null> {
    if (body.decision === "skip" || body.decision === "not_in_catalog") return null;
    let itemId: string | undefined;
    if (body.decision === "accept") {
      const offered = new Set([
        ...(row.itemId ? [row.itemId] : []),
        ...(row.candidates ?? []).map((candidate) => candidate.itemId),
      ]);
      itemId = body.itemId ?? row.itemId ?? undefined;
      if (!itemId) {
        throw validationError("itemId", "Choose one of the candidates");
      }
      if (!offered.has(itemId)) {
        throw validationError("itemId", "«Верно» takes the proposed item or one of the candidates");
      }
    } else {
      itemId = body.itemId;
      if (!itemId) throw validationError("itemId", "Choose the item");
    }
    const [company] = await tx
      .select({ type: supplier.type })
      .from(supplier)
      .where(eq(supplier.id, supplierId));
    const items = await itemsByIds(tx, [itemId]);
    const refusal = itemRefusal(items.get(itemId), company?.type ?? "goods");
    if (refusal !== null) throw itemUnavailable(refusal);
    return itemId;
  }

  private async missingCounts(
    executor: DbExecutor,
    record: PriceImportRecord,
  ): Promise<{ offers: number; withActiveOrders: number }> {
    const result = await executor.execute<{ offers: number; with_active_orders: number }>(
      missingOffersQuery(record, { count: true }),
    );
    const row = result.rows[0];
    return { offers: row?.offers ?? 0, withActiveOrders: row?.with_active_orders ?? 0 };
  }

  /** Rows whose new price would change the offer's sharply, and of them those not confirmed. */
  private async sharpCounts(
    executor: DbExecutor,
    record: PriceImportRecord,
  ): Promise<{ rows: number; unconfirmed: number }> {
    const percent = await this.settings.get("price_change_threshold_percent");
    const result = await executor.execute<{ rows: number; unconfirmed: number }>(sql`
      SELECT count(*)::int AS rows, count(*) FILTER (WHERE NOT r.price_confirmed)::int AS unconfirmed
      FROM price_import_row r
      JOIN supplier_location l ON l.supplier_id = ${record.supplierId} AND l.is_default
      JOIN offer o ON o.supplier_id = ${record.supplierId} AND o.location_id = l.id
        AND o.item_id = coalesce(r.decision_item_id, r.item_id)
      WHERE r.import_id = ${record.id} AND r.kind = 'data'
        AND r.match_group IN ('confident', 'review')
        AND coalesce(r.decision, '') NOT IN ('skip', 'not_in_catalog')
        AND o.price > 0
        AND abs((r.parsed->>'price')::numeric - o.price) * 100 > ${percent} * o.price`);
    return result.rows[0] ?? { rows: 0, unconfirmed: 0 };
  }

  private async describe(executor: DbExecutor, record: PriceImportRecord): Promise<PriceImport> {
    const ids = [record.uploadedByMemberId, record.appliedByMemberId].filter(
      (id): id is string => id !== null,
    );
    const names = await this.memberNames(executor, ids);
    return describeImport(
      record,
      names.get(record.uploadedByMemberId) ?? null,
      record.appliedByMemberId ? (names.get(record.appliedByMemberId) ?? null) : null,
    );
  }

  /** Rows as the review shows them, with their items, candidates and the company's offers. */
  private async describeRows(
    executor: DbExecutor,
    supplierId: string,
    rows: readonly PriceImportRowRecord[],
    lang: CatalogLanguage,
  ): Promise<PriceReviewRow[]> {
    if (rows.length === 0) return [];
    const itemIds = rows.flatMap((row) => [
      ...(row.itemId ? [row.itemId] : []),
      ...(row.decisionItemId ? [row.decisionItemId] : []),
      ...(row.candidates ?? []).map((candidate) => candidate.itemId),
    ]);
    const finals = rows.flatMap((row) => {
      const itemId = row.decisionItemId ?? row.itemId;
      return itemId ? [itemId] : [];
    });
    const [items, offers, names, percent, requests] = await Promise.all([
      describeOfferItems(executor, this.photos, itemIds, lang),
      finals.length === 0
        ? Promise.resolve([])
        : executor
            .select({
              itemId: offer.itemId,
              id: offer.id,
              status: offer.status,
              price: offer.price,
              availability: offer.availability,
              leadDays: offer.leadDays,
            })
            .from(offer)
            .innerJoin(
              supplierLocation,
              and(eq(supplierLocation.id, offer.locationId), eq(supplierLocation.isDefault, true)),
            )
            .where(
              and(eq(offer.supplierId, supplierId), inArray(offer.itemId, [...new Set(finals)])),
            ),
      this.memberNames(
        executor,
        rows.flatMap((row) => (row.decidedByMemberId ? [row.decidedByMemberId] : [])),
      ),
      this.settings.get("price_change_threshold_percent"),
      requestKeys(executor, supplierId),
    ]);
    const offerByItem = new Map(offers.map((row) => [row.itemId, row]));
    const item = (id: string | null): OfferItem | null => (id ? (items.get(id) ?? null) : null);
    return rows.map((row) => {
      const final = row.decisionItemId ?? row.itemId;
      const current = final ? offerByItem.get(final) : undefined;
      const price = row.parsed?.price ?? null;
      return {
        rowNo: row.rowNo,
        group: CONTRACT_GROUP[row.matchGroup ?? "error"],
        parsed: row.parsed,
        errors: rowErrors(row),
        source: row.matchSource,
        byName: row.matchKeyKind === "name",
        item: item(row.itemId),
        candidates: (row.candidates ?? []).flatMap((candidate) => {
          const described = item(candidate.itemId);
          return described ? [described] : [];
        }),
        aiProposed: row.aiProposed,
        aiConfidence: row.aiConfidence === null ? null : Number(row.aiConfidence),
        aiExplanation: row.aiExplanation,
        note: row.matchNote,
        offer: current
          ? {
              id: current.id,
              status: current.status,
              price: current.price,
              availability: current.availability,
              leadDays: current.leadDays,
            }
          : null,
        sharpPrice:
          current !== undefined &&
          price !== null &&
          sharpPriceChange(current.price, price, percent),
        decision:
          row.decision && row.decidedByMemberId && row.decidedAt
            ? {
                kind: row.decision,
                itemId: row.decisionItemId,
                by: {
                  memberId: row.decidedByMemberId,
                  name: names.get(row.decidedByMemberId) ?? null,
                },
                at: row.decidedAt.toISOString(),
              }
            : null,
        priceConfirmed: row.priceConfirmed,
        sendRequest:
          row.matchGroup === "not_found" || row.decision === "not_in_catalog"
            ? sendsRequest(
                {
                  sendRequest: row.sendRequest,
                  source: row.matchSource,
                  decision: row.decision,
                },
                requests.rejected.has(`${row.matchKeyKind}:${row.matchKey}`),
              )
            : false,
        requestRejectReason:
          row.matchGroup === "not_found" || row.decision === "not_in_catalog"
            ? (requests.rejectReasons.get(`${row.matchKeyKind}:${row.matchKey}`) ?? null)
            : null,
        outcome: row.outcome ? { kind: row.outcome, reason: row.outcomeReason } : null,
      };
    });
  }

  private async memberName(executor: DbExecutor, memberId: string): Promise<string | null> {
    return (await this.memberNames(executor, [memberId])).get(memberId) ?? null;
  }

  private async memberNames(
    executor: DbExecutor,
    ids: readonly string[],
  ): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await executor
      .select({ id: supplierMember.id, name: supplierMember.displayName })
      .from(supplierMember)
      .where(inArray(supplierMember.id, unique));
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  private rowCursor(cursor: string): number {
    if (!/^\d{1,10}$/.test(cursor) || Number(cursor) > 2_147_483_647) throw badCursor();
    return Number(cursor);
  }

  private missingCursor(cursor: string): { createdAt: string; id: string } {
    try {
      const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      if (
        Array.isArray(value) &&
        typeof value[0] === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(value[0]) &&
        typeof value[1] === "string" &&
        /^[0-9a-f-]{36}$/i.test(value[1])
      ) {
        return { createdAt: value[0], id: value[1] };
      }
    } catch {
      // Falls through to the refusal.
    }
    throw badCursor();
  }
}
