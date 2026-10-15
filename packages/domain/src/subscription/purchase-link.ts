/**
 * Whose a purchase is (ARCHITECTURE 9.4.1 rules 2 and 6, 4.72; TASK-040;
 * applied to the stores by TASK-041). A purchase — a store's original
 * transaction, a processor's subscription — belongs to the account that
 * first brought it, for good: the same Apple ID or Google account on two
 * phone numbers doesn't make one subscription serve two people
 * (`SUBSCRIPTION_LINKED_TO_ANOTHER_ACCOUNT`; moving it is the
 * administrator's act). An account has one current subscription: a new
 * purchase while another one gives access is refused («Подписка уже
 * активна»); one that gives no access any more (suspended, unconfirmed past
 * its tolerance) gives way to it.
 */
export interface PurchaseLinkFacts {
  /** The account the purchase already belongs to; `null` — never seen. */
  purchaseOwner: string | null;
  /** The account bringing the purchase now. */
  claimant: string;
  /** The claimant's current subscription by another purchase, if any. */
  otherCurrent: { grantsAccess: boolean } | null;
}

export type PurchaseLinkVerdict =
  /** The purchase is the claimant's already: apply the event to it. */
  | { kind: "same_account" }
  /** A new purchase of the claimant: a new subscription (and `replaces` — the old one ends). */
  | { kind: "link_new"; replaces: boolean }
  /** The purchase is another account's: refused, it stays there. */
  | { kind: "linked_to_another_account" }
  /** The claimant pays for another purchase that still gives access: refused. */
  | { kind: "already_active" };

export function purchaseLinkVerdict(facts: PurchaseLinkFacts): PurchaseLinkVerdict {
  if (facts.purchaseOwner !== null) {
    return facts.purchaseOwner === facts.claimant
      ? { kind: "same_account" }
      : { kind: "linked_to_another_account" };
  }
  if (facts.otherCurrent === null) {
    return { kind: "link_new", replaces: false };
  }
  return facts.otherCurrent.grantsAccess
    ? { kind: "already_active" }
    : { kind: "link_new", replaces: true };
}
