/**
 * The administrator's spot check of AI matches of price lists (TASK-065;
 * D-075; ARCHITECTURE 4.94): which applied rows are put aside for a check,
 * what «Неверно» does to the offer the row made, and the confidence buckets
 * the accuracy is shown by. Pure functions — the worker, the API and the
 * tests decide by the same rules.
 */

/** What an applied row did to an offer. */
export type PriceAuditRowOutcome =
  | "created"
  | "updated"
  | "unchanged"
  | "returned"
  | "withdrawn"
  | "requested"
  | "skipped"
  | "not_applied";

/** A row of an applied import, as the sampling rule needs it. */
export interface PriceAuditRowFacts {
  /** Stable per row: the sample does not depend on chance (`importId:rowNo`). */
  id: string;
  aiProposed: boolean;
  /** The supplier's decision: «Верно» is `accept`, «Другая позиция» is `other`. */
  decision: string | null;
  /** The item the supplier's decision named. */
  decisionItemId: string | null;
  /** The item AI chose: the first candidate of a row AI proposed. */
  aiItemId: string | null;
  aiConfidence: number | null;
  outcome: PriceAuditRowOutcome | null;
}

export interface PriceAuditSampling {
  /** `price_match_audit_share`. */
  share: number;
  /** `price_match_audit_always_below`. */
  alwaysBelow: number;
}

/** Outcomes that mean the row made, changed or confirmed an offer. */
const APPLIED_OUTCOMES: ReadonlySet<PriceAuditRowOutcome> = new Set([
  "created",
  "updated",
  "unchanged",
  "returned",
]);

/**
 * The supplier accepted the item AI chose and the row was applied with it.
 * Rows by memory, by the exact article, and «Другая позиция» never count.
 */
export function acceptedAiMatch(row: PriceAuditRowFacts): boolean {
  return (
    row.aiProposed &&
    row.decision === "accept" &&
    row.aiItemId !== null &&
    row.decisionItemId === row.aiItemId &&
    row.outcome !== null &&
    APPLIED_OUTCOMES.has(row.outcome)
  );
}

/**
 * A number in [0, 1) fixed by the row's id (32-bit FNV-1a): the same row is
 * always in or out of the sample, and the share holds over many rows.
 */
export function auditDraw(id: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash / 0x1_0000_0000;
}

/** Why a row was put aside, or `null` — it isn't. */
export type PriceAuditReason = "below" | "share";

export function priceAuditReason(
  row: PriceAuditRowFacts,
  sampling: PriceAuditSampling,
): PriceAuditReason | null {
  if (!acceptedAiMatch(row)) return null;
  // Near the threshold a mistake costs most: every such row is checked.
  if (row.aiConfidence !== null && row.aiConfidence < sampling.alwaysBelow) return "below";
  return auditDraw(row.id) < sampling.share ? "share" : null;
}

/** The offer a wrong row made or changed, as «Неверно» needs it. */
export interface PriceAuditOfferFacts {
  status: "active" | "withdrawn" | "suspended";
  /** Someone changed it by hand (not by a price list) after the row was applied. */
  editedByHand: boolean;
  /** Orders on it not yet finished. */
  activeOrders: number;
  /**
   * What the row did to the offer when applied (TASK-065.A); `null` — a
   * check put aside before the outcome was kept: as before, the row's.
   */
  rowOutcome: PriceAuditRowOutcome | null;
  /** The offer was made by a price list (not by hand); `false` — by hand or not known. */
  createdByImport: boolean;
}

export type PriceAuditOfferVerdict =
  | { withdraw: true }
  | {
      withdraw: false;
      reason: "no_offer" | "not_by_row" | "not_active" | "edited" | "active_orders";
    };

/**
 * Whether the offer is the row's own (TASK-065.A): made (`created`) or
 * returned to sale by it; changed by it (`updated`) only when a price list
 * made it in the first place — an offer the supplier put by hand stays
 * theirs, whatever a wrong row did to its price. `unchanged` — the row only
 * confirmed an offer that was there: not the row's.
 */
export function priceAuditOfferIsRows(
  offer: Pick<PriceAuditOfferFacts, "rowOutcome" | "createdByImport">,
): boolean {
  switch (offer.rowOutcome) {
    case null:
    case "created":
    case "returned":
      return true;
    case "updated":
      return offer.createdByImport;
    default:
      return false;
  }
}

/**
 * What «Неверно» does to the offer on the wrong item (D-075): withdrawn
 * with `match_corrected` only while it is the row's own
 * (`priceAuditOfferIsRows`), still active, untouched by hand, and without
 * an order a customer is waiting on — a customer's order outweighs the
 * wrong match, and a hand edit is the supplier's own word on the offer.
 */
export function priceAuditOfferVerdict(offer: PriceAuditOfferFacts | null): PriceAuditOfferVerdict {
  if (!offer) return { withdraw: false, reason: "no_offer" };
  if (!priceAuditOfferIsRows(offer)) return { withdraw: false, reason: "not_by_row" };
  if (offer.status !== "active") return { withdraw: false, reason: "not_active" };
  if (offer.activeOrders > 0) return { withdraw: false, reason: "active_orders" };
  if (offer.editedByHand) return { withdraw: false, reason: "edited" };
  return { withdraw: true };
}

/** The confidence buckets the accuracy is shown by (D-075). */
export const PRICE_AUDIT_BUCKETS = [
  { id: "lt_0_7", from: 0.5, to: 0.7 },
  { id: "0_7_0_85", from: 0.7, to: 0.85 },
  { id: "0_85_0_95", from: 0.85, to: 0.95 },
  { id: "gte_0_95", from: 0.95, to: null },
] as const;

export type PriceAuditBucket = (typeof PRICE_AUDIT_BUCKETS)[number]["id"];

/**
 * The bucket of a confidence: from inclusive, to exclusive; the first takes
 * anything below 0.7 (the threshold can't go under 0.5, but a sampled row
 * below it is still counted somewhere).
 */
export function priceAuditBucket(confidence: number): PriceAuditBucket {
  for (const bucket of PRICE_AUDIT_BUCKETS) {
    if (bucket.to === null || confidence < bucket.to) return bucket.id;
  }
  return "gte_0_95";
}
