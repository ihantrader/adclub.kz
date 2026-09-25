import type { CatalogLanguage, RepeatOrderResponse } from "@adclub/contracts";
import { orderRepeatDecision } from "@adclub/domain";
import { eq } from "drizzle-orm";
import type { DbExecutor } from "../../database";
import { supplier } from "../identity";
import { describeReceipt, offer, offerShowcase, receiptSchedules } from "../offers";
import { city, supplierLocation } from "../suppliers";
import { itemOf } from "./order-views";
import type { OrderRow } from "./schema";

/**
 * «Повторить заказ» (PRODUCT 6.5; SCREENS M-ORD-02, M-ORD-03, F1x;
 * ARCHITECTURE 4.33; TASK-023 requirement 3): what the button can do with
 * a finished order right now. The decision itself is the pure
 * `orderRepeatDecision` of `@adclub/domain`; here it is only fed the facts
 * and dressed for the screen.
 *
 * The price is read from the offer as it is today, never from the order's
 * snapshot: the user learns that it changed here, at the button, instead
 * of being refused at the checkout (`ORDER_PRICE_CHANGED`). The order
 * itself is then placed by the ordinary `POST /orders` — repeating never
 * becomes a second way to create one.
 */
export async function repeatView(
  executor: DbExecutor,
  row: OrderRow,
  hasClubAccess: boolean,
  lang: CatalogLanguage,
  at: Date,
): Promise<RepeatOrderResponse> {
  const item = itemOf(row, lang);
  const [current] = await executor
    .select({
      id: offer.id,
      locationId: offer.locationId,
      price: offer.price,
      availability: offer.availability,
      leadDays: offer.leadDays,
      pickup: offer.pickup,
      delivery: offer.delivery,
      warrantyMonths: offer.warrantyMonths,
      warrantyText: offer.warrantyText,
      supplierName: supplier.name,
      district: supplierLocation.district,
      cityName: city.nameRu,
    })
    .from(offer)
    .innerJoin(supplier, eq(supplier.id, offer.supplierId))
    .innerJoin(supplierLocation, eq(supplierLocation.id, offer.locationId))
    .innerJoin(city, eq(city.id, supplierLocation.cityId))
    .where(eq(offer.id, row.offerId));
  // The one showcase rule (4.28 I278): an offer that is gone answers the
  // same way whether it was withdrawn, its supplier paused or its point
  // has no working day ahead.
  const sign = current ? (await offerShowcase(executor, [current.id], at)).get(current.id) : null;
  const decision = orderRepeatDecision({
    orderKind: row.kind,
    hasClubAccess,
    offerVisible: sign?.visible ?? false,
    hiddenReasons: sign?.reasons ?? ["offer_withdrawn"],
  });
  if (decision.kind === "unavailable") {
    return { result: "unavailable", reason: decision.reason };
  }
  if (decision.kind === "catalog") {
    return { result: "catalog", item, reason: decision.reason };
  }
  const schedule = (await receiptSchedules(executor, [current!.locationId])).get(
    current!.locationId,
  );
  return {
    result: "offer",
    item,
    offer: {
      id: current!.id,
      price: current!.price,
      availability: current!.availability,
      leadDays: current!.leadDays,
      pickup: current!.pickup,
      delivery: current!.delivery,
      warrantyMonths: current!.warrantyMonths,
      warrantyText: current!.warrantyText,
      supplier: {
        name: current!.supplierName,
        cityName: current!.cityName,
        district: current!.district,
      },
      // The offer is on the showcase, so its point has a schedule and a date.
      receipt: describeReceipt(
        schedule ?? { timeZone: "UTC", weeklyHours: null, closedDates: [] },
        current!.leadDays,
        at,
      ),
    },
    previous: {
      quantity: row.quantity,
      fulfillment: row.fulfillment,
      unitPrice: row.unitPrice,
    },
    priceChanged: current!.price !== row.unitPrice,
  };
}
