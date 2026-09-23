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
 * schedule since D-060) at the same moment the dates are calculated for.
 * The date: only `receiptDate` of `@adclub/domain`, by the point's
 * schedule (`receiptSchedules`). The rule already leaves out every offer
 * whose date can't be had — the one reason is `scheduleFact`, which both
 * take (TASK-020.A) — so the check below never drops a shown offer; it
 * stays so that a user never sees an offer without a date whatever
 * happens (D-060).
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

/**
 * The offers a user can get of an item of this kind in the chosen city:
 * a product from anywhere; a service only in the chosen city, and none
 * without a city (PRODUCT 6.3, D-031). The one place of the rule — the
 * list, the card and its analogs (TASK-020.A).
 */
export function offersInReach(
  kind: "goods" | "services",
  offers: readonly VisibleOffer[],
  cityId: string | null,
): VisibleOffer[] {
  return kind === "services"
    ? offers.filter((entry) => cityId !== null && entry.cityId === cityId)
    : [...offers];
}

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
    .where(and(where, shownOffers(now)));
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
