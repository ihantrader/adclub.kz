import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  auditActions,
  auditEntities,
  type AdminItemOffersResponse,
  type CatalogLanguage,
  type CreateOfferBody,
  type OfferAvailability,
  type OfferListQuery,
  type OfferPage,
  type OfferReceipt,
  type OfferReturnedResponse,
  type SupplierOffer,
  type SupplierType,
  type UpdateOfferBody,
} from "@adclub/contracts";
import { normalizeArticle, supplierOffers, warrantyTextContacts } from "@adclub/domain";
import { and, count, desc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import { DatabaseService, type DbExecutor } from "../../database";
import { AuditLog, type AuditActorRecord } from "../audit";
import {
  CatalogPhotosService,
  catalogItem,
  category,
  decodeCursor,
  encodeCursor,
  escapeLike,
  normalizeText,
  TIME_POSITION,
} from "../catalog";
import { supplier } from "../identity";
import { AppSettings } from "../settings";
import { supplierLocation } from "../suppliers";
import {
  itemUnavailable,
  notApplicable,
  notFound,
  offerExists,
  offerState,
  pickupNeedsAddress,
  validationError,
  versionConflict,
  warrantyContacts,
} from "./offer-errors";
import { activeOrderCounts } from "./offer-active-orders";
import { OFFER_ON_SALE_STATUSES } from "./offer-list-rule";
import { describeOfferItems } from "./offer-items";
import { describePricings, modelAvailability } from "./offer-pricing";
import { describeReceipt, receiptSchedules } from "./offer-receipt";
import { offerShowcase } from "./offer-showcase";
import { offer, offerModelPrice, type OfferRow } from "./schema";

/** An employee acting for the company of the session. */
export type OfferActor = Extract<AuditActorRecord, { role: "supplier" }>;

/** The position of an offer in the lists: its creation time to the microsecond. */
const createdPosition = sql<string>`to_char(${offer.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** The terms of an offer as they become after a change: the rules hold for the whole. */
interface Terms {
  availability: OfferAvailability;
  leadDays: number;
  pickup: boolean;
  delivery: boolean;
  warrantyMonths: number | null;
  warrantyText: string | null;
}

/** The fields of the contract and their columns, in the order the journal lists them. */
const FIELDS = [
  ["price", "price"],
  ["availability", "availability"],
  ["leadDays", "leadDays"],
  ["pickup", "pickup"],
  ["delivery", "delivery"],
  ["warrantyMonths", "warrantyMonths"],
  ["warrantyText", "warrantyText"],
  ["supplierSku", "supplierSku"],
  ["supplierName", "supplierRawName"],
] as const satisfies readonly (readonly [keyof UpdateOfferBody, keyof OfferRow])[];

/**
 * The fields a service doesn't have (TASK-019): it is done at the point —
 * no availability, term, pickup or delivery. Its row holds the neutral
 * values (`SERVICE_TERMS`; the database refuses anything else).
 */
const GOODS_ONLY_FIELDS = ["availability", "leadDays", "pickup", "delivery"] as const;

const SERVICE_TERMS = {
  availability: "in_stock",
  leadDays: 0,
  pickup: false,
  delivery: false,
} as const;

/** A row of a service's prices by model, as kept and journaled. */
interface ModelPriceValue {
  modelId: string;
  price: number;
}

function sameModelPrices(a: readonly ModelPriceValue[], b: readonly ModelPriceValue[]): boolean {
  const key = (rows: readonly ModelPriceValue[]) =>
    [...rows]
      .sort((x, y) => x.modelId.localeCompare(y.modelId))
      .map((row) => `${row.modelId}:${row.price}`)
      .join(",");
  return key(a) === key(b);
}

function checkTerms(terms: Terms, changed: (field: string) => boolean, service: boolean): void {
  if (!service && terms.availability === "on_order" && terms.leadDays === 0) {
    throw validationError(
      changed("leadDays") ? "leadDays" : "availability",
      "Under order needs a term of at least one working day",
    );
  }
  if (!service && !terms.pickup && !terms.delivery) {
    throw validationError(
      changed("delivery") && !changed("pickup") ? "delivery" : "pickup",
      "Choose pickup, delivery or both",
    );
  }
  if (terms.warrantyMonths !== null && terms.warrantyText !== null) {
    throw validationError(
      changed("warrantyText") ? "warrantyText" : "warrantyMonths",
      "The warranty is given in months or as a text, not both",
    );
  }
  // No contacts in the warranty (TASK-020.A, D-026): checked on the offer
  // as it would be saved, so a text saved before the check is refused on
  // the next save of the offer, whatever field that save changes.
  if (terms.warrantyText !== null) {
    const found = warrantyTextContacts(terms.warrantyText);
    if (found.length > 0) {
      throw warrantyContacts(found);
    }
  }
}

/**
 * Offers of suppliers (TASK-018; ARCHITECTURE 4.28; SCREENS S-OFF-01,
 * S-OFF-03, A-SUP-03): an employee puts an offer of the company's pickup
 * point on an active part, product or — TASK-019, S-OFF-04 — service (as
 * far as the company's type lets it: `supplierOffers`), changes it field by
 * field straight from the list (a service's table of prices by model —
 * whole), withdraws it and returns it. The company is always the
 * session's; another company's offer is as missing as one that doesn't
 * exist. Every change is one transaction with its entry in the action
 * journal (the author — the employee). A change applies to new orders:
 * an order keeps the snapshot it was created with (`OfferSnapshots`).
 */
@Injectable()
export class OffersService {
  private readonly logger = new Logger("Offers");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditLog) private readonly audit: AuditLog,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(CatalogPhotosService) private readonly photos: CatalogPhotosService,
  ) {}

  // ---------------------------------------------------------------- change

  async create(
    input: CreateOfferBody,
    actor: OfferActor,
    lang: CatalogLanguage,
  ): Promise<SupplierOffer> {
    const changed = (field: string) => field in input;
    return this.database.db.transaction(async (tx) => {
      const item = await this.offerableItem(tx, input.itemId);
      // The type of the company decides what it may offer (TASK-019).
      const supplierType = await this.supplierTypeOf(tx, actor.supplierId);
      if (!supplierOffers(supplierType, item.itemType)) {
        throw notApplicable(supplierType, item.itemType);
      }
      const service = item.itemType === "service";
      // The point's address can't be cleared while the offer is put on it.
      const location = await this.pointOf(tx, actor.supplierId, "share");
      let terms: Terms;
      let price: number;
      let modelPrices: ModelPriceValue[] = [];
      if (service) {
        this.refuseGoodsFields(input);
        const pricing = await this.servicePricing(tx, input, new Set());
        price = pricing.price;
        modelPrices = pricing.modelPrices;
        terms = {
          ...SERVICE_TERMS,
          warrantyMonths: input.warrantyMonths ?? null,
          warrantyText: input.warrantyText ?? null,
        };
      } else {
        const goods = this.goodsInput(input);
        await this.checkPrice(goods.price);
        await this.checkLeadDays(goods.leadDays);
        price = goods.price;
        terms = {
          availability: goods.availability,
          leadDays: goods.leadDays,
          pickup: goods.pickup,
          delivery: goods.delivery,
          warrantyMonths: input.warrantyMonths ?? null,
          warrantyText: input.warrantyText ?? null,
        };
      }
      checkTerms(terms, changed, service);
      if (terms.pickup && !location.address) {
        throw pickupNeedsAddress();
      }
      const [created] = await tx
        .insert(offer)
        .values({
          supplierId: actor.supplierId,
          locationId: location.id,
          itemId: item.id,
          itemType: item.itemType,
          price,
          priceMode: modelPrices.length > 0 ? "by_model" : "single",
          ...terms,
          supplierSku: input.supplierSku ?? null,
          supplierRawName: input.supplierName ?? null,
          createdByMemberId: actor.memberId,
          updatedByMemberId: actor.memberId,
        })
        // One item — one offer of a point: a concurrent insert waits for
        // the other one and then finds it here.
        .onConflictDoNothing({ target: [offer.supplierId, offer.locationId, offer.itemId] })
        .returning();
      if (!created) {
        const [existing] = await tx
          .select({ id: offer.id, status: offer.status })
          .from(offer)
          .where(
            and(
              eq(offer.supplierId, actor.supplierId),
              eq(offer.locationId, location.id),
              eq(offer.itemId, item.id),
            ),
          );
        throw offerExists(existing!.id, existing!.status);
      }
      if (modelPrices.length > 0) {
        await tx.insert(offerModelPrice).values(
          modelPrices.map((row) => ({
            offerId: created.id,
            vehicleModelId: row.modelId,
            price: row.price,
          })),
        );
      }
      await this.audit.record(
        {
          action: auditActions.offerCreated,
          actor,
          entityType: auditEntities.offer,
          entityId: created.id,
          after: {
            itemId: created.itemId,
            locationId: created.locationId,
            ...this.journalFields(created),
            ...(service && { priceMode: created.priceMode }),
            ...(modelPrices.length > 0 && { modelPrices }),
          },
        },
        tx,
      );
      this.logger.log(`Offer created offer=${created.id} supplier=${actor.supplierId}`);
      return (await this.describe(tx, [created], lang))[0]!;
    });
  }

  async update(
    offerId: string,
    input: UpdateOfferBody,
    actor: OfferActor,
    lang: CatalogLanguage,
  ): Promise<SupplierOffer> {
    if (input.price !== undefined) {
      await this.checkPrice(input.price);
    }
    if (input.leadDays !== undefined) {
      await this.checkLeadDays(input.leadDays);
    }
    return this.database.db.transaction(async (tx) => {
      const row = await this.lockOwn(tx, actor.supplierId, offerId, input.expectedVersion);
      const service = row.itemType === "service";
      // A service: one price, or the whole table of prices by model (TASK-019).
      let price = input.price ?? row.price;
      let priceMode = row.priceMode;
      const currentModels: ModelPriceValue[] =
        row.priceMode === "by_model"
          ? (
              await tx
                .select({ modelId: offerModelPrice.vehicleModelId, price: offerModelPrice.price })
                .from(offerModelPrice)
                .where(eq(offerModelPrice.offerId, row.id))
            ).sort((a, b) => a.modelId.localeCompare(b.modelId))
          : [];
      let nextModels = currentModels;
      if (service) {
        this.refuseGoodsFields(input);
        if (input.price !== undefined && input.modelPrices !== undefined) {
          throw validationError(
            "modelPrices",
            "One price for all models or prices by model, not both",
          );
        }
        if (input.price !== undefined) {
          priceMode = "single";
          nextModels = [];
        } else if (input.modelPrices !== undefined) {
          const pricing = await this.servicePricing(
            tx,
            { modelPrices: input.modelPrices },
            new Set(currentModels.map((entry) => entry.modelId)),
          );
          priceMode = "by_model";
          price = pricing.price;
          nextModels = [...pricing.modelPrices].sort((a, b) => a.modelId.localeCompare(b.modelId));
        }
      } else if (input.modelPrices !== undefined) {
        throw validationError("modelPrices", "Prices by model are a service's only");
      }
      const next = {
        price,
        availability: input.availability ?? row.availability,
        leadDays: input.leadDays ?? row.leadDays,
        pickup: input.pickup ?? row.pickup,
        delivery: input.delivery ?? row.delivery,
        warrantyMonths:
          input.warrantyMonths === undefined ? row.warrantyMonths : input.warrantyMonths,
        warrantyText: input.warrantyText === undefined ? row.warrantyText : input.warrantyText,
        supplierSku: input.supplierSku === undefined ? row.supplierSku : input.supplierSku,
        supplierRawName:
          input.supplierName === undefined ? row.supplierRawName : input.supplierName,
      };
      checkTerms(next, (field) => field in input, service);
      if (next.pickup && !row.pickup) {
        const location = await this.pointOf(tx, actor.supplierId, "share");
        if (!location.address) {
          throw pickupNeedsAddress();
        }
      }
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      for (const [field, column] of FIELDS) {
        if (row[column] !== next[column]) {
          before[field] = row[column];
          after[field] = next[column];
        }
      }
      if (priceMode !== row.priceMode) {
        before.priceMode = row.priceMode;
        after.priceMode = priceMode;
      }
      const modelsChanged = !sameModelPrices(currentModels, nextModels);
      if (modelsChanged) {
        before.modelPrices = currentModels;
        after.modelPrices = nextModels;
      }
      if (Object.keys(after).length === 0) {
        // Saving what is already there changes nothing, not even the version.
        return (await this.describe(tx, [row], lang))[0]!;
      }
      const [updated] = await tx
        .update(offer)
        .set({
          ...next,
          priceMode,
          version: row.version + 1,
          updatedByMemberId: actor.memberId,
          updatedAt: new Date(),
        })
        .where(eq(offer.id, row.id))
        .returning();
      if (modelsChanged) {
        // The whole table is replaced; the database checks the price is its lowest at commit.
        await tx.delete(offerModelPrice).where(eq(offerModelPrice.offerId, row.id));
        if (nextModels.length > 0) {
          await tx.insert(offerModelPrice).values(
            nextModels.map((entry) => ({
              offerId: row.id,
              vehicleModelId: entry.modelId,
              price: entry.price,
            })),
          );
        }
      }
      await this.audit.record(
        {
          action: auditActions.offerChanged,
          actor,
          entityType: auditEntities.offer,
          entityId: row.id,
          before,
          after: { ...after, version: updated!.version },
        },
        tx,
      );
      this.logger.log(`Offer changed offer=${row.id} fields=${Object.keys(after).join(",")}`);
      return (await this.describe(tx, [updated!], lang))[0]!;
    });
  }

  async withdraw(
    offerId: string,
    expectedVersion: number,
    actor: OfferActor,
    lang: CatalogLanguage,
  ): Promise<SupplierOffer> {
    return this.database.db.transaction(async (tx) => {
      const row = await this.lockOwn(tx, actor.supplierId, offerId, expectedVersion);
      if (row.status !== "active") {
        throw offerState(row.status, "withdraw");
      }
      const now = new Date();
      const [updated] = await tx
        .update(offer)
        .set({
          status: "withdrawn",
          withdrawnAt: now,
          withdrawnReason: "manual",
          version: row.version + 1,
          updatedByMemberId: actor.memberId,
          updatedAt: now,
        })
        .where(eq(offer.id, row.id))
        .returning();
      await this.audit.record(
        {
          action: auditActions.offerWithdrawn,
          actor,
          entityType: auditEntities.offer,
          entityId: row.id,
          before: { status: row.status },
          after: { status: "withdrawn", reason: "manual", version: updated!.version },
        },
        tx,
      );
      this.logger.log(`Offer withdrawn offer=${row.id}`);
      return (await this.describe(tx, [updated!], lang))[0]!;
    });
  }

  async returnToSale(
    offerId: string,
    expectedVersion: number,
    actor: OfferActor,
    lang: CatalogLanguage,
  ): Promise<OfferReturnedResponse> {
    return this.database.db.transaction(async (tx) => {
      const row = await this.lockOwn(tx, actor.supplierId, offerId, expectedVersion);
      if (row.status !== "withdrawn") {
        throw offerState(row.status, "return");
      }
      const [item] = await tx
        .select({ status: catalogItem.status })
        .from(catalogItem)
        .where(eq(catalogItem.id, row.itemId))
        .for("share");
      if (item?.status !== "active") {
        throw itemUnavailable();
      }
      // The type of the company may have changed since (TASK-019).
      const supplierType = await this.supplierTypeOf(tx, actor.supplierId);
      if (!supplierOffers(supplierType, row.itemType)) {
        throw notApplicable(supplierType, row.itemType);
      }
      const [updated] = await tx
        .update(offer)
        .set({
          status: "active",
          withdrawnAt: null,
          withdrawnReason: null,
          version: row.version + 1,
          updatedByMemberId: actor.memberId,
          updatedAt: new Date(),
        })
        .where(eq(offer.id, row.id))
        .returning();
      await this.audit.record(
        {
          action: auditActions.offerReturned,
          actor,
          entityType: auditEntities.offer,
          entityId: row.id,
          before: { status: row.status, reason: row.withdrawnReason },
          after: { status: "active", version: updated!.version },
        },
        tx,
      );
      this.logger.log(`Offer returned offer=${row.id}`);
      // The price was set before the offer was withdrawn: the cabinet asks to check it.
      return { offer: (await this.describe(tx, [updated!], lang))[0]!, checkPrice: true };
    });
  }

  // ----------------------------------------------------------------- reads

  /** One offer of the company; another company's answers like a missing one. */
  async own(supplierId: string, offerId: string, lang: CatalogLanguage): Promise<SupplierOffer> {
    const executor = this.database.db;
    const [row] = await executor
      .select()
      .from(offer)
      .where(and(eq(offer.id, offerId), eq(offer.supplierId, supplierId)));
    if (!row) {
      throw notFound("offer");
    }
    return (await this.describe(executor, [row], lang))[0]!;
  }

  async page(supplierId: string, query: OfferListQuery, lang: CatalogLanguage): Promise<OfferPage> {
    const executor = this.database.db;
    const after = query.cursor ? decodeCursor(query.cursor) : undefined;
    if (after && !TIME_POSITION.test(after.position)) {
      throw validationError("cursor", "Use the nextCursor of the previous page");
    }
    const filters: (SQL | undefined)[] = [
      eq(offer.supplierId, supplierId),
      query.tab === "withdrawn"
        ? eq(offer.status, "withdrawn")
        : inArray(offer.status, ["active", "suspended"]),
      query.kind === "services"
        ? eq(offer.itemType, "service")
        : query.kind === "goods"
          ? ne(offer.itemType, "service")
          : undefined,
      query.availability ? eq(offer.availability, query.availability) : undefined,
      query.withoutPhoto === "true"
        ? sql`NOT EXISTS (SELECT 1 FROM catalog_item i WHERE i.id = ${offer.itemId} AND i.primary_photo_id IS NOT NULL)`
        : query.withoutPhoto === "false"
          ? sql`EXISTS (SELECT 1 FROM catalog_item i WHERE i.id = ${offer.itemId} AND i.primary_photo_id IS NOT NULL)`
          : undefined,
      query.q ? this.searchCondition(query.q) : undefined,
    ];
    const [rows, [total], tabs] = await Promise.all([
      executor
        .select({ offer, position: createdPosition })
        .from(offer)
        .where(
          and(
            ...filters,
            after
              ? sql`(${offer.createdAt}, ${offer.id}) < (${after.position}::timestamptz, ${after.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(offer.createdAt), desc(offer.id))
        .limit(query.limit + 1),
      executor
        .select({ value: count() })
        .from(offer)
        .where(and(...filters)),
      executor
        .select({ status: offer.status, value: count() })
        .from(offer)
        .where(eq(offer.supplierId, supplierId))
        .groupBy(offer.status),
    ]);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const tab = (statuses: readonly string[]) =>
      tabs.filter((row) => statuses.includes(row.status)).reduce((sum, row) => sum + row.value, 0);
    return {
      language: lang,
      offers: await this.describe(
        executor,
        page.map((row) => row.offer),
        lang,
      ),
      total: total?.value ?? 0,
      counts: { onSale: tab(["active", "suspended"]), withdrawn: tab(["withdrawn"]) },
      nextCursor:
        rows.length > query.limit && last ? encodeCursor(last.position, last.offer.id) : null,
    };
  }

  /** The admin view of a supplier's offers (read only); an unknown supplier — 404. */
  async adminPage(
    supplierId: string,
    query: OfferListQuery,
    lang: CatalogLanguage,
  ): Promise<OfferPage> {
    const [row] = await this.database.db
      .select({ id: supplier.id })
      .from(supplier)
      .where(eq(supplier.id, supplierId));
    if (!row) {
      throw notFound("supplier");
    }
    return this.page(supplierId, query, lang);
  }

  /**
   * Every offer on one item for the administrator (TASK-035; SCREENS
   * A-CAT-05 «Предложения», read only): on sale first, newest first, with
   * the showcase sign, the active orders and whose offer it is, and the two
   * numbers the archiving of the item warns about. An unknown item — 404.
   */
  async forItem(itemId: string, lang: CatalogLanguage): Promise<AdminItemOffersResponse> {
    const executor = this.database.db;
    const [item] = await executor
      .select({ id: catalogItem.id })
      .from(catalogItem)
      .where(eq(catalogItem.id, itemId));
    if (!item) {
      throw notFound("item");
    }
    const rows = await executor
      .select({ offer, supplierName: supplier.name })
      .from(offer)
      .innerJoin(supplier, eq(supplier.id, offer.supplierId))
      .where(eq(offer.itemId, itemId))
      .orderBy(
        sql`CASE WHEN ${inArray(offer.status, [...OFFER_ON_SALE_STATUSES])} THEN 0 ELSE 1 END`,
        desc(offer.createdAt),
        desc(offer.id),
      );
    const described = await this.describe(
      executor,
      rows.map((row) => row.offer),
      lang,
    );
    const onSale = new Set<string>(OFFER_ON_SALE_STATUSES);
    return {
      itemId,
      language: lang,
      offers: described.map((entry, index) => ({
        ...entry,
        supplier: { id: entry.supplierId, name: rows[index]!.supplierName },
      })),
      onSale: described.filter((entry) => onSale.has(entry.status)).length,
      activeOrders: described.reduce((sum, entry) => sum + entry.activeOrders, 0),
    };
  }

  /** The receipt date of a term for an order confirmed now, by the company's point. */
  async previewReceipt(supplierId: string, leadDays: number): Promise<OfferReceipt> {
    await this.checkLeadDays(leadDays);
    const location = await this.pointOf(this.database.db, supplierId, null);
    const schedules = await receiptSchedules(this.database.db, [location.id]);
    return describeReceipt(schedules.get(location.id)!, leadDays, new Date());
  }

  // --------------------------------------------------------------- helpers

  /** Offers as the cabinet and the admin panel show them, in the order given. */
  async describe(
    executor: DbExecutor,
    rows: readonly OfferRow[],
    lang: CatalogLanguage,
  ): Promise<SupplierOffer[]> {
    if (rows.length === 0) {
      return [];
    }
    const now = new Date();
    const [items, showcase, schedules, activeOrders, pricings] = await Promise.all([
      describeOfferItems(
        executor,
        this.photos,
        rows.map((row) => row.itemId),
        lang,
      ),
      offerShowcase(
        executor,
        rows.map((row) => row.id),
        now,
      ),
      receiptSchedules(
        executor,
        rows.map((row) => row.locationId),
      ),
      activeOrderCounts(
        executor,
        rows.map((row) => row.id),
      ),
      describePricings(executor, rows),
    ]);
    return rows.map((row) => ({
      id: row.id,
      supplierId: row.supplierId,
      locationId: row.locationId,
      item: items.get(row.itemId)!,
      price: row.price,
      pricing: pricings.get(row.id)!,
      currency: row.currency,
      availability: row.availability,
      leadDays: row.leadDays,
      pickup: row.pickup,
      delivery: row.delivery,
      warrantyMonths: row.warrantyMonths,
      warrantyText: row.warrantyText,
      supplierSku: row.supplierSku,
      supplierName: row.supplierRawName,
      status: row.status,
      withdrawnAt: row.withdrawnAt ? row.withdrawnAt.toISOString() : null,
      withdrawnReason: row.withdrawnReason,
      showcase: showcase.get(row.id)!,
      receipt: describeReceipt(schedules.get(row.locationId)!, row.leadDays, now),
      activeOrders: activeOrders.get(row.id) ?? 0,
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  private journalFields(row: OfferRow): Record<string, unknown> {
    return Object.fromEntries(FIELDS.map(([field, column]) => [field, row[column]]));
  }

  private async checkPrice(price: number, path = "price"): Promise<void> {
    const [min, max] = await Promise.all([
      this.settings.get("offer_price_min_kzt"),
      this.settings.get("offer_price_max_kzt"),
    ]);
    if (price < min || price > max) {
      throw validationError(path, `The price must be from ${min} to ${max} tenge`, { min, max });
    }
  }

  /** The company's type (PRODUCT 12.1), held until the offer is saved. */
  private async supplierTypeOf(executor: DbExecutor, supplierId: string): Promise<SupplierType> {
    const [row] = await executor
      .select({ type: supplier.type })
      .from(supplier)
      .where(eq(supplier.id, supplierId))
      .for("share");
    if (!row) {
      throw notFound("supplier");
    }
    return row.type;
  }

  /** A service is done at the point (TASK-019): the fields of goods are refused at their path. */
  private refuseGoodsFields(input: Partial<Record<(typeof GOODS_ONLY_FIELDS)[number], unknown>>) {
    for (const field of GOODS_ONLY_FIELDS) {
      if (input[field] !== undefined) {
        throw validationError(
          field,
          "A service is done at the point: it has no availability, term, pickup or delivery",
        );
      }
    }
  }

  /** The terms an offer on goods can't do without; prices by model are a service's only. */
  private goodsInput(input: CreateOfferBody) {
    if (input.modelPrices !== undefined) {
      throw validationError("modelPrices", "Prices by model are a service's only");
    }
    const { price, availability, leadDays, pickup, delivery } = input;
    for (const [field, value] of Object.entries({
      price,
      availability,
      leadDays,
      pickup,
      delivery,
    })) {
      if (value === undefined) {
        throw validationError(field, "Required for an offer on goods");
      }
    }
    return {
      price: price!,
      availability: availability!,
      leadDays: leadDays!,
      pickup: pickup!,
      delivery: delivery!,
    };
  }

  /**
   * The price of a service (S-OFF-04): one for all models, or a table of
   * prices by model — exactly one of them. Every price within the settings
   * (an error at its row); a model must be one clients can choose — a model
   * in the archive may only stay in a table that already has it (`kept`):
   * its price stays, nobody sees it. With a table the offer's price is its
   * lowest («от N ₸»; the database checks it).
   */
  private async servicePricing(
    executor: DbExecutor,
    input: { price?: number; modelPrices?: readonly ModelPriceValue[] },
    kept: ReadonlySet<string>,
  ): Promise<{ price: number; modelPrices: ModelPriceValue[] }> {
    if (input.price !== undefined && input.modelPrices !== undefined) {
      throw validationError("modelPrices", "One price for all models or prices by model, not both");
    }
    if (input.price !== undefined) {
      await this.checkPrice(input.price);
      return { price: input.price, modelPrices: [] };
    }
    if (input.modelPrices === undefined || input.modelPrices.length === 0) {
      throw validationError("price", "Give one price for all models or prices by model");
    }
    const rows = input.modelPrices;
    for (const [index, row] of rows.entries()) {
      await this.checkPrice(row.price, `modelPrices.${index}.price`);
    }
    const models = await modelAvailability(
      executor,
      rows.map((row) => row.modelId),
    );
    for (const [index, row] of rows.entries()) {
      const available = models.get(row.modelId);
      if (available === undefined) {
        throw validationError(
          `modelPrices.${index}.modelId`,
          "No such model in the vehicle catalog",
        );
      }
      if (!available && !kept.has(row.modelId)) {
        throw validationError(
          `modelPrices.${index}.modelId`,
          "The model is in the archive: clients can't choose it",
        );
      }
    }
    return {
      price: Math.min(...rows.map((row) => row.price)),
      modelPrices: rows.map((row) => ({ modelId: row.modelId, price: row.price })),
    };
  }

  private async checkLeadDays(leadDays: number): Promise<void> {
    const max = await this.settings.get("offer_lead_days_max");
    if (leadDays > max) {
      throw validationError("leadDays", `The term must be at most ${max} working days`, {
        min: 0,
        max,
      });
    }
  }

  /** The company's pickup point (one in the MVP), optionally locked. */
  private async pointOf(
    executor: DbExecutor,
    supplierId: string,
    lock: "share" | null,
  ): Promise<{ id: string; address: string | null }> {
    const query = executor
      .select({ id: supplierLocation.id, address: supplierLocation.address })
      .from(supplierLocation)
      .where(
        and(eq(supplierLocation.supplierId, supplierId), eq(supplierLocation.isDefault, true)),
      );
    const [row] = lock ? await query.for(lock) : await query;
    if (!row) {
      // Every supplier gets its point when it is created (4.26 I251).
      throw new Error(`The supplier ${supplierId} has no pickup point`);
    }
    return row;
  }

  /**
   * An item a supplier may put an offer on: active, in a visible
   * subcategory (a supplier sees the catalog as users do — anything else
   * is as missing as an item that doesn't exist) — a part, a product or,
   * since TASK-019, a service. Held against archiving until the offer is saved.
   */
  private async offerableItem(
    executor: DbExecutor,
    itemId: string,
  ): Promise<{ id: string; itemType: "part" | "generic" | "service" }> {
    const [row] = await executor
      .select({ id: catalogItem.id, itemType: catalogItem.itemType, status: catalogItem.status })
      .from(catalogItem)
      .where(
        and(
          eq(catalogItem.id, itemId),
          sql`EXISTS (
            SELECT 1 FROM ${category} c LEFT JOIN ${category} p ON p.id = c.parent_id
            WHERE c.id = ${catalogItem.categoryId} AND c.status = 'active'
              AND coalesce(p.status, 'active') = 'active'
          )`,
        ),
      )
      .for("share");
    if (!row || row.status !== "active") {
      throw notFound("item");
    }
    return { id: row.id, itemType: row.itemType };
  }

  private async lockOwn(
    executor: DbExecutor,
    supplierId: string,
    offerId: string,
    expectedVersion: number,
  ): Promise<OfferRow> {
    const [row] = await executor
      .select()
      .from(offer)
      .where(and(eq(offer.id, offerId), eq(offer.supplierId, supplierId)))
      .for("update");
    if (!row) {
      throw notFound("offer");
    }
    if (row.version !== expectedVersion) {
      throw versionConflict(row.version);
    }
    return row;
  }

  /** `q`: a part of the item's article (any spelling) or name (any language), or of the own article. */
  private searchCondition(q: string): SQL {
    const article = normalizeArticle(q);
    const pattern = `%${escapeLike(normalizeText(q))}%`;
    const byItem = sql`EXISTS (
      SELECT 1 FROM catalog_item i WHERE i.id = ${offer.itemId} AND (
        ${article === "" ? sql`false` : sql`strpos(i.article_norm, ${article}) > 0`}
        OR EXISTS (SELECT 1 FROM translation t WHERE t.entity_type = 'catalog_item' AND t.entity_id = i.id AND t.field = 'name' AND lower(t.text) LIKE lower(${pattern}) ESCAPE '\\')
      )
    )`;
    return sql`(${byItem} OR lower(${offer.supplierSku}) LIKE lower(${pattern}) ESCAPE '\\' OR lower(${offer.supplierRawName}) LIKE lower(${pattern}) ESCAPE '\\')`;
  }
}
