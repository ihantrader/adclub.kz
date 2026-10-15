/**
 * The state machine of a subscription (PRODUCT 14; ARCHITECTURE 5.10, 9.4.1,
 * 9.4.2, 4.72; TASK-040). One table decides which event moves a
 * subscription of which audience from which status to which; the server
 * applies an event only through it — the events of a provider (a store for
 * a user, a card processor for a supplier) and the events of time (the
 * sweeper). The client never tells the server a subscription is active.
 *
 * **A user** (subscriptions of the stores, 9.4.1): `active` — paid;
 * `grace` — the store failed to charge and keeps its grace period (access
 * stays, PRODUCT 14.3); `cancelled` — the user switched renewal off, the
 * paid term runs to its end; `suspended` — the store stopped access and may
 * still restore it (Apple «billing retry», Google «on hold»); `expired` —
 * over (the store said so, a refund, a revocation, or confirmation never
 * came); `expired_unconfirmed` — the term (or the grace) passed and the
 * store said neither «renewed» nor «over»: we wait `store_lag_tolerance_hours`
 * with access still on (U-5 — a person doesn't lose access because a store
 * is late), then `expired`. A late «renewed» restores `active` from any
 * status, retroactively (9.4.1 rule 7).
 *
 * **A supplier** (a card processor, 9.4.2; applied by TASK-042): `active`,
 * `past_due` — a charge failed, retries until `grace_until`
 * (`billing_retry_days`), then `suspended` (the supplier is paused for
 * `billing`); `cancelled`, `expired` as for a user. A supplier's term passing
 * waits for the processor's charge: time alone ends only a cancelled term.
 */

export const subscriptionAudiences = ["user", "supplier"] as const;

export type SubscriptionAudience = (typeof subscriptionAudiences)[number];

export const subscriptionStatuses = [
  "active",
  "grace",
  "past_due",
  "cancelled",
  "expired_unconfirmed",
  "suspended",
  "expired",
] as const;

export type SubscriptionStatus = (typeof subscriptionStatuses)[number];

/** The statuses each audience can be in. */
export const audienceStatuses: Record<SubscriptionAudience, readonly SubscriptionStatus[]> = {
  user: ["active", "grace", "cancelled", "expired_unconfirmed", "suspended", "expired"],
  supplier: ["active", "past_due", "cancelled", "suspended", "expired"],
};

/**
 * **The one definition of «текущая подписка»**: every status but `expired`.
 * An account (or a company) has at most one current subscription — the
 * database keeps it so (a partial unique index); an expired one is history.
 */
export function isCurrentSubscription(status: SubscriptionStatus): boolean {
  return status !== "expired";
}

/**
 * What a provider says, in our general words (the table of a store's or a
 * processor's own names is the provider's implementation, 9.4.1 rule 3):
 *
 * - `started` — a purchase confirmed, the first term paid until `periodEnd`;
 * - `renewed` — a term paid until `periodEnd` (also a resubscription, and a
 *   payment that clears a grace or a hold);
 * - `grace_started` — a store's charge failed, access kept until `graceUntil`;
 * - `payment_failed` — a processor's charge failed, retries until `graceUntil`;
 * - `suspended` — access stopped by the provider, it may still restore it;
 * - `cancelled` — renewal switched off, the paid term runs to its end;
 * - `cancel_withdrawn` — renewal switched back on before the end;
 * - `expired` — the provider says the subscription is over;
 * - `refunded`, `revoked` — money returned, or the purchase revoked: over now.
 */
export const providerEventKinds = [
  "started",
  "renewed",
  "grace_started",
  "payment_failed",
  "suspended",
  "cancelled",
  "cancel_withdrawn",
  "expired",
  "refunded",
  "revoked",
] as const;

export type ProviderEventKind = (typeof providerEventKinds)[number];

/**
 * The events of time (the sweeper): the term passed (`period_lapsed`), the
 * grace or the retries passed (`grace_lapsed`), the tolerance of an
 * unconfirmed status passed (`tolerance_lapsed`).
 */
export const timeEventKinds = ["period_lapsed", "grace_lapsed", "tolerance_lapsed"] as const;

export type TimeEventKind = (typeof timeEventKinds)[number];

export type SubscriptionEventKind = ProviderEventKind | TimeEventKind;

export const subscriptionEventKinds: readonly SubscriptionEventKind[] = [
  ...providerEventKinds,
  ...timeEventKinds,
];

/** The events each audience's provider (and time) can bring. */
const audienceEvents: Record<SubscriptionAudience, ReadonlySet<SubscriptionEventKind>> = {
  user: new Set<SubscriptionEventKind>([
    "started",
    "renewed",
    "grace_started",
    "suspended",
    "cancelled",
    "cancel_withdrawn",
    "expired",
    "refunded",
    "revoked",
    "period_lapsed",
    "grace_lapsed",
    "tolerance_lapsed",
  ]),
  supplier: new Set<SubscriptionEventKind>([
    "started",
    "renewed",
    "payment_failed",
    "suspended",
    "cancelled",
    "cancel_withdrawn",
    "expired",
    "period_lapsed",
    "grace_lapsed",
  ]),
};

/** The moments of a subscription the machine reads and moves. */
export interface SubscriptionTimes {
  /** The end of the paid term. */
  periodEnd: Date;
  /** The end of a store's grace or of a processor's retries; `null` — none. */
  graceUntil: Date | null;
  /** The moment the status stopped being confirmed (`expired_unconfirmed`); `null` otherwise. */
  unconfirmedSince: Date | null;
}

export interface SubscriptionState extends SubscriptionTimes {
  status: SubscriptionStatus;
}

export interface SubscriptionEvent {
  kind: SubscriptionEventKind;
  /** `started`, `renewed`: the end of the paid term. */
  periodEnd?: Date;
  /** `grace_started`, `payment_failed`: the end of the grace or of the retries. */
  graceUntil?: Date;
}

/**
 * - `move` — the event changes the subscription: `next` is what to write
 *   (a new status, or new moments in the same status — a later grace);
 * - `stay` — the event is understood and changes nothing (a renewal that
 *   pays nothing new, an expiry of an expired subscription, time that hasn't
 *   come): applying it again is the same — no effect and no rollback;
 * - `not_applicable` — this audience's subscriptions don't have such
 *   events (a store's grace for a supplier, a processor's failure for a user).
 */
export type SubscriptionTransition =
  { kind: "move"; next: SubscriptionState } | { kind: "stay" } | { kind: "not_applicable" };

const STAY: SubscriptionTransition = { kind: "stay" };

function later(a: Date, b: Date): boolean {
  return a.getTime() > b.getTime();
}

function moveTo(
  state: SubscriptionState,
  status: SubscriptionStatus,
  times: Partial<SubscriptionTimes> = {},
): SubscriptionTransition {
  return { kind: "move", next: { ...state, status, ...times } };
}

/**
 * The state of a subscription a provider reports for the first time — the
 * event that creates it (`started` or `renewed`); `null` — no other event
 * creates one (a store's «expired» of a purchase we never saw is history,
 * not a subscription).
 */
export function initialSubscriptionState(event: SubscriptionEvent): SubscriptionState | null {
  if ((event.kind === "started" || event.kind === "renewed") && event.periodEnd) {
    return {
      status: "active",
      periodEnd: event.periodEnd,
      graceUntil: null,
      unconfirmedSince: null,
    };
  }
  return null;
}

/**
 * **The one table of moves.** `at` is now; `toleranceMs` —
 * `store_lag_tolerance_hours`: time events apply only once their moment
 * has come (`dueTimeEvent`), so the sweeper and a test may both ask.
 */
export function subscriptionTransition(
  audience: SubscriptionAudience,
  state: SubscriptionState,
  event: SubscriptionEvent,
  at: Date,
  toleranceMs: number,
): SubscriptionTransition {
  if (!audienceEvents[audience].has(event.kind)) {
    return { kind: "not_applicable" };
  }
  const { status } = state;
  switch (event.kind) {
    case "started":
    case "renewed": {
      // A term paid further than we know: active from any status — a late
      // confirmation restores access retroactively (9.4.1 rule 7). A term no
      // further than ours pays nothing new: a duplicate, or a renewal that
      // arrived before the expiry it follows.
      if (!event.periodEnd) return STAY;
      if (!later(event.periodEnd, state.periodEnd)) return STAY;
      return moveTo(state, "active", {
        periodEnd: event.periodEnd,
        graceUntil: null,
        unconfirmedSince: null,
      });
    }
    case "grace_started": {
      if (!event.graceUntil) return STAY;
      if (status === "active" || status === "expired_unconfirmed") {
        return moveTo(state, "grace", { graceUntil: event.graceUntil, unconfirmedSince: null });
      }
      if (status === "grace" && (!state.graceUntil || later(event.graceUntil, state.graceUntil))) {
        return moveTo(state, "grace", { graceUntil: event.graceUntil });
      }
      return STAY;
    }
    case "payment_failed": {
      if (!event.graceUntil) return STAY;
      if (status === "active") {
        return moveTo(state, "past_due", { graceUntil: event.graceUntil });
      }
      if (
        status === "past_due" &&
        (!state.graceUntil || later(event.graceUntil, state.graceUntil))
      ) {
        return moveTo(state, "past_due", { graceUntil: event.graceUntil });
      }
      return STAY;
    }
    case "suspended": {
      if (
        status === "active" ||
        status === "grace" ||
        status === "past_due" ||
        status === "expired_unconfirmed"
      ) {
        return moveTo(state, "suspended", { unconfirmedSince: null });
      }
      return STAY;
    }
    case "cancelled": {
      if (status === "active" || status === "grace" || status === "expired_unconfirmed") {
        return moveTo(state, "cancelled", { graceUntil: null, unconfirmedSince: null });
      }
      return STAY;
    }
    case "cancel_withdrawn": {
      return status === "cancelled" ? moveTo(state, "active") : STAY;
    }
    case "expired":
    case "refunded":
    case "revoked": {
      return status === "expired"
        ? STAY
        : moveTo(state, "expired", { graceUntil: null, unconfirmedSince: null });
    }
    case "period_lapsed": {
      if (at.getTime() < state.periodEnd.getTime()) return STAY;
      if (status === "cancelled") {
        // Renewal was off: the end is what the user chose, nothing to confirm.
        return moveTo(state, "expired");
      }
      if (status === "active" && audience === "user") {
        return moveTo(state, "expired_unconfirmed", { unconfirmedSince: state.periodEnd });
      }
      // A supplier's term waits for the processor's charge (TASK-042).
      return STAY;
    }
    case "grace_lapsed": {
      if (!state.graceUntil || at.getTime() < state.graceUntil.getTime()) return STAY;
      if (status === "grace") {
        return moveTo(state, "expired_unconfirmed", {
          unconfirmedSince: state.graceUntil,
          graceUntil: null,
        });
      }
      if (status === "past_due") {
        return moveTo(state, "suspended");
      }
      return STAY;
    }
    case "tolerance_lapsed": {
      if (status !== "expired_unconfirmed" || !state.unconfirmedSince) return STAY;
      if (at.getTime() < state.unconfirmedSince.getTime() + toleranceMs) return STAY;
      return moveTo(state, "expired", { unconfirmedSince: null });
    }
  }
}

/**
 * The event of time that is due for a subscription at `at`, if any — what
 * the sweeper applies (one per pass; the next pass takes the next one).
 */
export function dueTimeEvent(
  audience: SubscriptionAudience,
  state: SubscriptionState,
  at: Date,
  toleranceMs: number,
): TimeEventKind | null {
  for (const kind of timeEventKinds) {
    if (subscriptionTransition(audience, state, { kind }, at, toleranceMs).kind === "move") {
      return kind;
    }
  }
  return null;
}
