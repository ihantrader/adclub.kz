/**
 * The state of a supplier (PRODUCT 13, 14; SCREENS A-SUP-03, 6.0;
 * ARCHITECTURE 4.26, 4.77). Two pauses and blocking are independent: a
 * company the administrator paused may also be paused for an unpaid
 * subscription (and the other way round), and lifting one leaves the other.
 * Neither closes the cabinet nor touches current orders; all of them take
 * the supplier off the showcase.
 */

export type SupplierPauseReason = "billing" | "admin";

/** `blocked` wins over `paused`: it is the stronger decision. */
export type SupplierState = "active" | "paused" | "blocked";

export interface SupplierStateFacts {
  /** The administrator paused the company (`supplier.admin_paused_at`). */
  adminPaused: boolean;
  /** The subscription is unpaid and the retries are over (`supplier.billing_paused_at`, TASK-042). */
  billingPaused: boolean;
  blocked: boolean;
}

/** The pauses that hold, the administrator's first. */
export function supplierPauseReasons(
  facts: Pick<SupplierStateFacts, "adminPaused" | "billingPaused">,
): SupplierPauseReason[] {
  const reasons: SupplierPauseReason[] = [];
  if (facts.adminPaused) reasons.push("admin");
  if (facts.billingPaused) reasons.push("billing");
  return reasons;
}

export function supplierState(facts: SupplierStateFacts): SupplierState {
  if (facts.blocked) {
    return "blocked";
  }
  return facts.adminPaused || facts.billingPaused ? "paused" : "active";
}

/**
 * Whether the supplier's offers may be shown to users (EPIC-07 reads this
 * one rule): only an active supplier — not paused, not blocked. Being a
 * verified partner doesn't matter here.
 */
export function supplierVisibleOnShowcase(facts: SupplierStateFacts): boolean {
  return supplierState(facts) === "active";
}

/**
 * D-070: whether the supplier may add employees and send them invitations
 * (W-08) — the one thing a company does that writes outside the platform
 * on behalf of the club. A blocked company may not, neither from its
 * cabinet nor through an administrator; a paused one may. Changing offers,
 * the company, the schedule and the employees' settings stays open.
 */
export function supplierMayInvite(facts: Pick<SupplierStateFacts, "blocked">): boolean {
  return !facts.blocked;
}
