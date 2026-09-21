import type { SupplierPauseReason } from "../supplier/supplier-state";

/**
 * Whether an offer is shown to users, and why not (PRODUCT 9, 13, 14;
 * ARCHITECTURE 4.28; TASK-018 requirement 6). The server decides it by
 * this one rule for every consumer — the cabinet's sign, the admin panel
 * and the client catalog (TASK-020). Hiding changes nothing in the offer:
 * a supplier's pause or block hides its offers while it lasts, and they
 * are shown again when it is lifted.
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
  | "no_city";

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
}

export interface OfferVisibility {
  visible: boolean;
  /** In a fixed order: the offer, the supplier, the item, the category, the point. */
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
  return { visible: reasons.length === 0, reasons };
}
