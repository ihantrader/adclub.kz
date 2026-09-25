import type { OfferHiddenReason } from "../offer/offer-visibility";

/**
 * «Повторить заказ» on a finished order (PRODUCT 6.5; SCREENS M-ORD-02,
 * M-ORD-03 «Повторить заказ», F1x; ARCHITECTURE 4.33; TASK-023
 * requirement 3). One function decides what the button can do right now,
 * so the answer of the server and the screen never disagree:
 *
 * - **the same offer of the same supplier** — it is on the showcase, and
 *   the user is told its price as it is today (the snapshot's price is
 *   history; a changed price is learned here, not as a refusal at the
 *   checkout);
 * - **the catalog card of the item** — the offer has gone (withdrawn) or
 *   its supplier can't take orders now (paused, blocked, no hours, no
 *   working day ahead), but the item is still in the catalog and somebody
 *   else may have it;
 * - **nothing to repeat** — the item itself left the catalog (archived, or
 *   its category hidden), the user has no club access to order with
 *   (D-059), or the order is of a kind the server can't create yet
 *   (services and orders under order — EPIC-13, stage C).
 *
 * The order is then placed by the ordinary `POST /orders`: repeating never
 * becomes a second way to create an order.
 */

/** The facts the decision is made from; everything else is presentation. */
export interface OrderRepeatFacts {
  /** The kind of the finished order; only `stock` can be placed today. */
  orderKind: string;
  /** The user has club access now (D-059). */
  hasClubAccess: boolean;
  /** The offer is on the showcase now (the one rule, `offerVisibility`). */
  offerVisible: boolean;
  /** Why it isn't, in the order `offerVisibility` gives them. */
  hiddenReasons: readonly OfferHiddenReason[];
}

/** Why the same offer can't be ordered, though the item is still in the catalog. */
export type OrderRepeatBlocked = "offer_withdrawn" | "supplier_unavailable";

/** Why there is nothing to repeat at all. */
export type OrderRepeatImpossible =
  "item_unavailable" | "club_access_required" | "kind_not_supported";

export type OrderRepeatDecision =
  /** Order it again from the same offer, at its current price. */
  | { kind: "offer" }
  /** Open the item's card in the catalog instead. */
  | { kind: "catalog"; reason: OrderRepeatBlocked }
  | { kind: "unavailable"; reason: OrderRepeatImpossible };

/** The hidden reasons that mean the item itself is no longer in the catalog. */
const ITEM_GONE: readonly OfferHiddenReason[] = ["item_unavailable", "category_hidden"];

export function orderRepeatDecision(facts: OrderRepeatFacts): OrderRepeatDecision {
  // Without club access no order can be created at all (D-059): saying so
  // here is what sends the app to the subscription instead of the checkout.
  if (!facts.hasClubAccess) {
    return { kind: "unavailable", reason: "club_access_required" };
  }
  if (facts.orderKind !== "stock") {
    return { kind: "unavailable", reason: "kind_not_supported" };
  }
  if (facts.offerVisible) {
    return { kind: "offer" };
  }
  if (facts.hiddenReasons.some((reason) => ITEM_GONE.includes(reason))) {
    return { kind: "unavailable", reason: "item_unavailable" };
  }
  // «Поставщик снял это предложение» (M-ORD-01) — the one reason the user
  // is told plainly; everything else is «сейчас не принимает заявки».
  if (facts.hiddenReasons.includes("offer_withdrawn")) {
    return { kind: "catalog", reason: "offer_withdrawn" };
  }
  return { kind: "catalog", reason: "supplier_unavailable" };
}
