import type { OfferAvailability, ShowcaseReceipt } from "@adclub/contracts";
import { daysBetween, receiptDate, type ReceiptSchedule } from "@adclub/domain";
import { and, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import type { DbExecutor } from "../../database";
import { catalogItem } from "../catalog";
import { supplier } from "../identity";
import { offer, receiptSchedules, shownOffers } from "../offers";
import { supplierLocation } from "../suppliers";

/**
 * The offers users see (TASK-020; ARCHITECTURE 4.29), with what the
 * catalog needs of each: the terms, the city of the pickup point, whether
 * the supplier is a verified partner — and the receipt date for an order
 * confirmed now. Which offers: only the showcase rule of TASK-018
 * (`shownOffers`, the SQL twin of `offerVisibility`, with the point's
 * hours since D-060). The date: only `receiptDate` of `@adclub/domain`,
 * by the point's schedule (`receiptSchedules`). An offer whose date still
 * can't be calculated (every day of 60 closed by dates) isn't shown either:
 * a user always sees a date (D-060).
 *
 * One statement for the offers of a whole subcategory (or of a set of
 * items) and one for the schedules of their points, whatever their number;
 * the date is calculated once per point and term.
 *
 * Nothing here names the supplier beyond its id, which stays on the server
 * (`supplierId` never reaches an answer without club access — the
 * visibility of the supplier is `showcase-visibility.ts`).
 */
export interface VisibleOffer {
  id: string;
  itemId: string;
  supplierId: string;
  locationId: string;
  cityId: string;
  price: number;
  availability: OfferAvailability;
  leadDays: number;
  pickup: boolean;
  delivery: boolean;
  warrantyMonths: number | null;
  warrantyText: string | null;
  verified: boolean;
  receipt: ShowcaseReceipt;
  /** Calendar days from today (at the point) to the receipt date. */
  receiptDays: number;
}

export type OfferScope = { categoryId: string } | { itemIds: readonly string[] };

export async function visibleOffers(
  executor: DbExecutor,
  scope: OfferScope,
  now: Date,
): Promise<VisibleOffer[]> {
  if ("itemIds" in scope && scope.itemIds.length === 0) {
    return [];
  }
  const where: SQL =
    "categoryId" in scope
      ? eq(catalogItem.categoryId, scope.categoryId)
      : inArray(offer.itemId, [...scope.itemIds]);
  const rows = await executor
    .select({
      id: offer.id,
      itemId: offer.itemId,
      supplierId: offer.supplierId,
      locationId: offer.locationId,
      cityId: supplierLocation.cityId,
      price: offer.price,
      availability: offer.availability,
      leadDays: offer.leadDays,
      pickup: offer.pickup,
      delivery: offer.delivery,
      warrantyMonths: offer.warrantyMonths,
      warrantyText: offer.warrantyText,
      verified: sql<boolean>`${isNotNull(supplier.verifiedAt)}`,
    })
    .from(offer)
    .innerJoin(catalogItem, eq(catalogItem.id, offer.itemId))
    .innerJoin(supplierLocation, eq(supplierLocation.id, offer.locationId))
    .innerJoin(supplier, eq(supplier.id, offer.supplierId))
    .where(and(where, shownOffers()));
  if (rows.length === 0) {
    return [];
  }
  const schedules = await receiptSchedules(
    executor,
    rows.map((row) => row.locationId),
  );
  // One calculation per point and term: a subcategory of thousands of
  // offers has a handful of points.
  const dates = new Map<string, { receipt: ShowcaseReceipt; days: number } | null>();
  const dateOf = (locationId: string, leadDays: number) => {
    const key = `${locationId}:${leadDays}`;
    if (!dates.has(key)) {
      const schedule: ReceiptSchedule | undefined = schedules.get(locationId);
      const result = schedule ? receiptDate(now, leadDays, schedule) : null;
      dates.set(
        key,
        result?.ok && schedule
          ? {
              receipt: {
                date: result.date,
                confirmedOn: result.confirmedOn,
                timeZone: schedule.timeZone,
              },
              days: daysBetween(result.confirmedOn, result.date),
            }
          : null,
      );
    }
    return dates.get(key) ?? null;
  };
  const visible: VisibleOffer[] = [];
  for (const row of rows) {
    const date = dateOf(row.locationId, row.leadDays);
    if (!date) {
      continue;
    }
    visible.push({ ...row, receipt: date.receipt, receiptDays: date.days });
  }
  return visible;
}
