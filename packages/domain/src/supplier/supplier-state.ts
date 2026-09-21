/**
 * The state of a supplier (PRODUCT 13, 14; SCREENS A-SUP-03, 6.0;
 * ARCHITECTURE 4.26). Pause (for an unpaid subscription or by an
 * administrator) and blocking are independent: a blocked supplier may be
 * paused too, and lifting one leaves the other. Neither closes the
 * cabinet nor touches current orders; both take the supplier off the
 * showcase.
 */

export type SupplierPauseReason = "billing" | "admin";

/** `blocked` wins over `paused`: it is the stronger decision. */
export type SupplierState = "active" | "paused" | "blocked";

export interface SupplierStateFacts {
  pauseReason: SupplierPauseReason | null;
  blocked: boolean;
}

export function supplierState(facts: SupplierStateFacts): SupplierState {
  if (facts.blocked) {
    return "blocked";
  }
  return facts.pauseReason === null ? "active" : "paused";
}

/**
 * Whether the supplier's offers may be shown to users (EPIC-07 reads this
 * one rule): only an active supplier — not paused, not blocked. Being a
 * verified partner doesn't matter here.
 */
export function supplierVisibleOnShowcase(facts: SupplierStateFacts): boolean {
  return supplierState(facts) === "active";
}
