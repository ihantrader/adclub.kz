import type { SupplierPauseReason } from "../supplier/supplier-state";

/**
 * Whether an offer is shown to users, and why not (PRODUCT 9, 13, 14;
 * ARCHITECTURE 4.28; TASK-018 requirement 6). The server decides it by
 * this one rule for every consumer — the cabinet's sign, the admin panel
 * and the client catalog (TASK-020). Hiding changes nothing in the offer:
 * a supplier's pause or block hides its offers while it lasts, and they
 * are shown again when it is lifted. Since TASK-020 (D-060) the point's
 * hours count too: without them there is no receipt date to show.
 */

export type OfferStatus = "active" | "withdrawn" | "suspended";

/** Why an offer isn't on the showcase; several may apply at once. */
export type OfferHiddenReason =
  | "offer_withdrawn"
  | "offer_suspended"
  | "supplier_paused"
  | "supplier_blocked"
  | "item_unavailable"
  | "category_hidden"
  | "no_city"
  | "hours_not_set"
  | "no_working_day";

/**
 * The pickup point's hours as the receipt date needs them (D-060,
 * TASK-020): given with at least one working day a week; not given yet;
 * or given with no working day at all — then no date can be calculated.
 */
export type OfferScheduleFact = "ok" | "hours_not_set" | "no_working_day";

/** The schedule fact of a point from its weekly hours (`null` — not given yet). */
export function scheduleFact(
  weeklyHours: readonly { intervals: readonly unknown[] }[] | null,
): OfferScheduleFact {
  if (weeklyHours === null) {
    return "hours_not_set";
  }
  return weeklyHours.some((day) => day.intervals.length > 0) ? "ok" : "no_working_day";
}

export interface OfferVisibilityFacts {
  offerStatus: OfferStatus;
  supplierPauseReason: SupplierPauseReason | null;
  supplierBlocked: boolean;
  /** The catalog item: `draft`, `active` or `archived`. */
  itemStatus: string;
  /** The item's subcategory and its node are both active (neither hidden nor archived). */
  categoryVisible: boolean;
  /** The pickup point has a city. */
  hasCity: boolean;
  /**
   * The hours of the pickup point (D-060): an offer whose receipt date
   * can't be calculated isn't shown — a user always sees a date, never a
   * bare term (PRODUCT 9.1); the supplier sees the reason and fills the
   * hours in.
   */
  schedule: OfferScheduleFact;
}

export interface OfferVisibility {
  visible: boolean;
  /** In a fixed order: the offer, the supplier, the item, the category, the point, its hours. */
  reasons: OfferHiddenReason[];
}

export function offerVisibility(facts: OfferVisibilityFacts): OfferVisibility {
  const reasons: OfferHiddenReason[] = [];
  if (facts.offerStatus === "withdrawn") {
    reasons.push("offer_withdrawn");
  } else if (facts.offerStatus === "suspended") {
    reasons.push("offer_suspended");
  }
  if (facts.supplierBlocked) {
    reasons.push("supplier_blocked");
  }
  if (facts.supplierPauseReason !== null) {
    reasons.push("supplier_paused");
  }
  if (facts.itemStatus !== "active") {
    reasons.push("item_unavailable");
  }
  if (!facts.categoryVisible) {
    reasons.push("category_hidden");
  }
  if (!facts.hasCity) {
    reasons.push("no_city");
  }
  if (facts.schedule !== "ok") {
    reasons.push(facts.schedule);
  }
  return { visible: reasons.length === 0, reasons };
}
