import { warrantyTextContacts, type WarrantyContactKind } from "./warranty-text";

/**
 * The rules an offer on goods or a service must keep (TASK-018, TASK-019,
 * TASK-020.A), as one check for every way an offer is written: by hand in
 * the cabinet (`OffersService`) and from a price list (TASK-047). The
 * cabinet turns a problem into its error at the field; the import writes it
 * as the reason a row was not applied.
 */

/** The working range of a price and a term (settings `offer_price_*`, `offer_lead_days_max`). */
export interface OfferLimits {
  priceMin: number;
  priceMax: number;
  leadDaysMax: number;
}

/** An offer's terms as they would be saved. */
export interface OfferTerms {
  availability: "in_stock" | "on_order";
  leadDays: number;
  pickup: boolean;
  delivery: boolean;
  warrantyMonths: number | null;
  warrantyText: string | null;
}

export type OfferTermsProblem =
  | { code: "price_out_of_range"; min: number; max: number }
  | { code: "lead_days_out_of_range"; min: 0; max: number }
  | { code: "on_order_needs_lead_days" }
  | { code: "no_fulfillment" }
  | { code: "warranty_both" }
  | { code: "warranty_contacts"; found: WarrantyContactKind[] }
  | { code: "pickup_needs_address" };

export function offerPriceProblem(price: number, limits: OfferLimits): OfferTermsProblem | null {
  return price < limits.priceMin || price > limits.priceMax
    ? { code: "price_out_of_range", min: limits.priceMin, max: limits.priceMax }
    : null;
}

export function offerLeadDaysProblem(
  leadDays: number,
  limits: OfferLimits,
): OfferTermsProblem | null {
  return leadDays > limits.leadDaysMax
    ? { code: "lead_days_out_of_range", min: 0, max: limits.leadDaysMax }
    : null;
}

/**
 * The rules of the terms as a whole (a service is done at the point: no
 * term, no receiving): «под заказ» needs a term of a working day at least,
 * pickup or delivery, the warranty in months or as a text, never both, and
 * no contacts in the warranty text (D-026).
 */
export function offerTermsShapeProblem(
  terms: OfferTerms,
  service: boolean,
): OfferTermsProblem | null {
  if (!service && terms.availability === "on_order" && terms.leadDays === 0) {
    return { code: "on_order_needs_lead_days" };
  }
  if (!service && !terms.pickup && !terms.delivery) {
    return { code: "no_fulfillment" };
  }
  if (terms.warrantyMonths !== null && terms.warrantyText !== null) {
    return { code: "warranty_both" };
  }
  if (terms.warrantyText !== null) {
    const found = warrantyTextContacts(terms.warrantyText);
    if (found.length > 0) return { code: "warranty_contacts", found };
  }
  return null;
}

/**
 * Every rule at once, in the order the cabinet checks them: the price, the
 * term, the terms as a whole, and pickup at a point without an address
 * (`pickupNeedsAddress` — pickup is being switched on where the point has
 * no address). The first problem, or `null`.
 */
export function offerTermsProblem(
  price: number,
  terms: OfferTerms,
  facts: { service: boolean; limits: OfferLimits; pickupNeedsAddress: boolean },
): OfferTermsProblem | null {
  return (
    offerPriceProblem(price, facts.limits) ??
    offerLeadDaysProblem(terms.leadDays, facts.limits) ??
    offerTermsShapeProblem(terms, facts.service) ??
    (facts.pickupNeedsAddress ? { code: "pickup_needs_address" } : null)
  );
}
