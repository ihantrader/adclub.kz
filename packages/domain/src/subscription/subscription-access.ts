import type { SubscriptionState } from "./subscription-machine";

/**
 * **Whether a user's subscription gives club access, and until when**
 * (PRODUCT 14.2, 14.3; ARCHITECTURE 9.4.1, 4.72; TASK-040) — the one rule,
 * a table of cases:
 *
 * | status | access until |
 * |---|---|
 * | `active` | the end of the term + the tolerance (the term passing without word becomes `expired_unconfirmed`, which still gives access) |
 * | `grace` | the end of the store's grace (no earlier than the term's) + the tolerance |
 * | `cancelled` | the end of the paid term |
 * | `expired_unconfirmed` | the moment it stopped being confirmed + the tolerance (U-5) |
 * | `suspended`, `expired`, `past_due` | none |
 *
 * The rule reads only the moments, never «has the sweeper run yet»: a
 * subscription whose term passed a minute ago gives the same answer before
 * the sweeper marks it `expired_unconfirmed` and after. `toleranceMs` —
 * `store_lag_tolerance_hours`. A supplier's subscription gives no club
 * access at all (it puts offers on the showcase — TASK-042); callers ask
 * this only of users' subscriptions.
 */
export function subscriptionAccessUntil(
  state: SubscriptionState,
  toleranceMs: number,
): Date | null {
  switch (state.status) {
    case "active":
      return new Date(state.periodEnd.getTime() + toleranceMs);
    case "grace": {
      const end = Math.max(state.periodEnd.getTime(), state.graceUntil?.getTime() ?? 0);
      return new Date(end + toleranceMs);
    }
    case "cancelled":
      return state.periodEnd;
    case "expired_unconfirmed": {
      const since = state.unconfirmedSince ?? state.periodEnd;
      return new Date(since.getTime() + toleranceMs);
    }
    case "past_due":
    case "suspended":
    case "expired":
      return null;
  }
}

export interface SubscriptionAccess {
  granted: boolean;
  /** When the access ends without a new word from the store; `null` without access. */
  until: Date | null;
}

/** `subscriptionAccessUntil` at `at`: access is on while its end is ahead. */
export function subscriptionAccess(
  state: SubscriptionState,
  at: Date,
  toleranceMs: number,
): SubscriptionAccess {
  const until = subscriptionAccessUntil(state, toleranceMs);
  return until && until.getTime() > at.getTime()
    ? { granted: true, until }
    : { granted: false, until: null };
}

/** What gives club access: a grant by hand, or a subscription (TASK-040). */
export type ClubAccessSourceKind = "manual" | "subscription";

export interface ClubAccessCandidate {
  source: ClubAccessSourceKind;
  until: Date;
}

/**
 * Club access from its two sources (D-059, TASK-040): on if either gives it;
 * `until` — the farther end; `source` — whose end that is, a subscription
 * on a tie (it's the one the person pays for and sees in «Моя подписка»).
 */
export function combineClubAccess(
  candidates: readonly (ClubAccessCandidate | null)[],
  at: Date,
): { source: ClubAccessSourceKind; until: Date } | null {
  let best: ClubAccessCandidate | null = null;
  for (const candidate of candidates) {
    if (!candidate || candidate.until.getTime() <= at.getTime()) continue;
    if (
      !best ||
      candidate.until.getTime() > best.until.getTime() ||
      (candidate.until.getTime() === best.until.getTime() && candidate.source === "subscription")
    ) {
      best = candidate;
    }
  }
  return best;
}
