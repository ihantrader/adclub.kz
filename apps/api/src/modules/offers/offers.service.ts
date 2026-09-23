import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  auditActions,
  auditEntities,
  type CatalogLanguage,
  type CreateOfferBody,
  type OfferAvailability,
  type OfferListQuery,
  type OfferPage,
  type OfferReceipt,
  type OfferReturnedResponse,
  type SupplierOffer,
  type UpdateOfferBody,
} from "@adclub/contracts";
import { normalizeArticle, warrantyTextContacts } from "@adclub/domain";
import { and, count, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
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
import { describeOfferItems } from "./offer-items";
import { describeReceipt, receiptSchedules } from "./offer-receipt";
import { offerShowcase } from "./offer-showcase";
import { offer, type OfferRow } from "./schema";

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

function checkTerms(terms: Terms, changed: (field: string) => boolean): void {
  if (terms.availability === "on_order" && terms.leadDays === 0) {
    throw validationError(
      changed("leadDays") ? "leadDays" : "availability",
      "Under order needs a term of at least one working day",
    );
  }
  if (!terms.pickup && !terms.delivery) {
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
 * point on an active part or product, changes it field by field straight
 * from the list, withdraws it and returns it. The company is always the
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
    await this.checkPrice(input.price);
    await this.checkLeadDays(input.leadDays);
    const terms: Terms = {
      availability: input.availability,
      leadDays: input.leadDays,
      pickup: input.pickup,
      delivery: input.delivery,
      warrantyMonths: input.warrantyMonths ?? null,
      warrantyText: input.warrantyText ?? null,
    };
    checkTerms(terms, (field) => field in input);
    return this.database.db.transaction(async (tx) => {
      // The point's address can't be cleared while the offer is put on it.
      const location = await this.pointOf(tx, actor.supplierId, "share");
      if (terms.pickup && !location.address) {
        throw pickupNeedsAddress();
      }
      const item = await this.offerableItem(tx, input.itemId);
      const [created] = await tx
        .insert(offer)
        .values({
          supplierId: actor.supplierId,
          locationId: location.id,
          itemId: item.id,
          itemType: item.itemType,
          price: input.price,
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
      const next = {
        price: input.price ?? row.price,
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
      checkTerms(next, (field) => field in input);
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
      if (Object.keys(after).length === 0) {
        // Saving what is already there changes nothing, not even the version.
        return (await this.describe(tx, [row], lang))[0]!;
      }
      const [updated] = await tx
        .update(offer)
        .set({
          ...next,
          version: row.version + 1,
          updatedByMemberId: actor.memberId,
          updatedAt: new Date(),
        })
        .where(eq(offer.id, row.id))
        .returning();
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
    const [items, showcase, schedules] = await Promise.all([
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
    ]);
    return rows.map((row) => ({
      id: row.id,
      supplierId: row.supplierId,
      locationId: row.locationId,
      item: items.get(row.itemId)!,
      price: row.price,
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
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  private journalFields(row: OfferRow): Record<string, unknown> {
    return Object.fromEntries(FIELDS.map(([field, column]) => [field, row[column]]));
  }

  private async checkPrice(price: number): Promise<void> {
    const [min, max] = await Promise.all([
      this.settings.get("offer_price_min_kzt"),
      this.settings.get("offer_price_max_kzt"),
    ]);
    if (price < min || price > max) {
      throw validationError("price", `The price must be from ${min} to ${max} tenge`);
    }
  }

  private async checkLeadDays(leadDays: number): Promise<void> {
    const max = await this.settings.get("offer_lead_days_max");
    if (leadDays > max) {
      throw validationError("leadDays", `The term must be at most ${max} working days`);
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
   * is as missing as an item that doesn't exist), a part or a product.
   * Held against archiving until the offer is saved.
   */
  private async offerableItem(
    executor: DbExecutor,
    itemId: string,
  ): Promise<{ id: string; itemType: "part" | "generic" }> {
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
    if (row.itemType === "service") {
      throw notApplicable();
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
