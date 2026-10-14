import type { OrderAction, OrderKind, OrderStatus } from "../order/order-machine";
import { countsInStatistics, type OrderStatisticsFacts } from "../order/order-statistics";

/**
 * The rating of a supplier (PRODUCT 6, 10.5, 10.7, 13; SCREENS M-CAT-07,
 * M-CAT-09, A-SUP-03; ARCHITECTURE 5.9, 13.2, 4.71; TASK-050). **The one
 * place that decides it**: what an order says about the supplier, what the
 * parts add up to and when the rating is shown at all. The worker's
 * recalculation after an event and the nightly reconciliation both call
 * these, and the SQL count of the API (`ratings/rating-facts.ts`) is checked
 * against them on the same data.
 *
 * Three parts over the window `rating_window_days`:
 *
 * - **the scores** — the average of the published reviews (a hidden one
 *   does not count; «only the score» does);
 * - **the share of answers** — the orders the supplier answered in time
 *   (accepted, declined, proposed another term or time) out of the orders
 *   that wanted an answer (answered, or expired with none);
 * - **keeping the terms** — the orders kept out of the orders taken on that
 *   reached a verdict (`ratingOrderOutcome` below).
 *
 * Only orders that count in statistics (`countsInStatistics`): an
 * employee's test order is nothing to the rating.
 */

/** The facts of an order the rating judges by; `ratings/rating-facts.ts` reads them. */
export interface RatingOrderFacts extends OrderStatisticsFacts {
  kind: OrderKind;
  status: OrderStatus;
  /**
   * The supplier answered the new order itself: accepted it, declined it,
   * proposed another term or another time (a move of the journal from
   * `created`). A move can't be made after the deadline (the conditional
   * update and the lazy expiry of `OrderTransitions`), so an answer is an
   * answer in time — an extended deadline included.
   */
  answered: boolean;
  /** The deadline of the answer passed with none (`expire_no_response` in the journal). */
  expiredUnanswered: boolean;
  /**
   * The supplier took the order on: confirmed it, or the user agreed to the
   * term or the time it proposed — the order was `accepted` at some point.
   */
  takenOn: boolean;
  /** Given out by the code after its reserve or its visit had expired (PRODUCT 10.7). */
  closedLate: boolean;
  /** Closed by an administrator without a code (D-043). */
  closedByAdmin: boolean;
  /** Under order: the confirmed date passed while the goods were not ready (TASK-037). */
  supplyOverdue: boolean;
}

/** `answered` — answered in time; `silent` — the deadline passed with no answer; `null` — no answer was due. */
export type RatingAnswer = "answered" | "silent" | null;

/** `kept` — done in time; `missed` — the supplier failed it; `null` — says nothing about the supplier (yet). */
export type RatingTerm = "kept" | "missed" | null;

/**
 * What one order says about its supplier. The table (ARCHITECTURE 4.71
 * I763) for all three kinds:
 *
 * | fact | answer | term |
 * |---|---|---|
 * | test order | — | — |
 * | accepted / declined / another term or time proposed from «new» | answered | |
 * | expired without an answer (also closed later by an administrator) | silent | |
 * | cancelled by the user or the administrator while «new» | — | — |
 * | not taken on (declined at once, term or time not agreed, user's silence) | | — |
 * | taken on, then given out by the code in time | | kept |
 * | taken on, then declined by the supplier (supplier failed) | | missed |
 * | under order, the confirmed date passed while not ready | | missed |
 * | a service visit left unresolved by the supplier | | missed |
 * | given out late (reserve or visit expired, then the code) | | — |
 * | closed by an administrator without a code | | — |
 * | reserve expired (the user didn't come), service no-show | | — |
 * | cancelled by the user or the administrator after taking on | | — |
 * | still going on (no verdict yet, nothing overdue) | | — |
 *
 * A late close is neither kept nor missed: PRODUCT 10.7 — it does not
 * affect the rating, so it can't improve it (debt of TASK-022), and the
 * no-show it replaced did not count against the supplier either.
 */
export function ratingOrderOutcome(order: RatingOrderFacts): {
  answer: RatingAnswer;
  term: RatingTerm;
} {
  if (!countsInStatistics(order)) {
    return { answer: null, term: null };
  }
  const answer: RatingAnswer = order.answered
    ? "answered"
    : order.expiredUnanswered
      ? "silent"
      : null;
  return { answer, term: order.takenOn ? termOf(order) : null };
}

function termOf(order: RatingOrderFacts): RatingTerm {
  if (order.supplyOverdue) {
    return "missed";
  }
  switch (order.status) {
    case "declined_by_supplier":
    case "visit_unresolved":
      return "missed";
    case "completed":
      return order.closedLate || order.closedByAdmin ? null : "kept";
    default:
      return null;
  }
}

/** The orders of a supplier, counted (the SQL count of the API gives the same numbers). */
export interface RatingOrderTally {
  /** Answered in time. */
  answered: number;
  /** Wanted an answer: answered or silent. */
  answerRequired: number;
  /** Kept. */
  kept: number;
  /** Reached a verdict: kept or missed. */
  judged: number;
}

export function tallyRatingOrders(orders: readonly RatingOrderFacts[]): RatingOrderTally {
  const tally: RatingOrderTally = { answered: 0, answerRequired: 0, kept: 0, judged: 0 };
  for (const order of orders) {
    const { answer, term } = ratingOrderOutcome(order);
    if (answer !== null) {
      tally.answerRequired += 1;
      if (answer === "answered") {
        tally.answered += 1;
      }
    }
    if (term !== null) {
      tally.judged += 1;
      if (term === "kept") {
        tally.kept += 1;
      }
    }
  }
  return tally;
}

/**
 * The version of the formula below, kept in every snapshot. The weights,
 * the thresholds and the window are data (settings): changing them changes
 * the rating, not the version.
 */
export const RATING_FORMULA_VERSION = 1;

/** The weights of the setting `rating_weights` (they add up to 1). */
export interface RatingWeights {
  reviews: number;
  response_rate: number;
  deadline_rate: number;
}

export interface RatingRules {
  /** `rating_min_reviews`: fewer published scores — «Новый поставщик». */
  minReviews: number;
  /** `rating_min_orders`: fewer orders behind a share — «Мало заявок для оценки», the share is left out. */
  minOrders: number;
  weights: RatingWeights;
}

export interface RatingInputs extends RatingOrderTally {
  /** Published reviews in the window. */
  reviewsCount: number;
  /** The sum of their scores. */
  reviewsScoreSum: number;
}

export interface SupplierRating {
  /** 1–5 to one decimal; `null` — «Новый поставщик». */
  score: number | null;
  isNew: boolean;
  /** The average of the scores (to two decimals); `null` — no review. */
  reviewsAverage: number | null;
  /** 0–1; `null` — fewer than `minOrders` orders wanted an answer. */
  responseRate: number | null;
  /** 0–1; `null` — fewer than `minOrders` orders reached a verdict. */
  onTimeRate: number | null;
}

/**
 * A share on the scale of the scores: 0 % — 1 ★, 100 % — 5 ★ (`1 + 4 ×
 * share`), so the parts are of one measure and the weighted sum stays
 * between 1 and 5.
 */
export function shareOnScale(share: number): number {
  return 1 + 4 * Math.min(1, Math.max(0, share));
}

/** Half up to one decimal (4.25 → 4.3), without the float's 4.2499999. */
export function roundRating(value: number): number {
  return Math.round(value * 10 + 1e-9) / 10;
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor + 1e-9) / factor;
}

/**
 * The rating: the **weighted sum** of the parts by `rating_weights`
 * (ARCHITECTURE 13.2 said «произведение»; with weights adding up to 1 it is a
 * sum — 4.71 I762). A share left out for too few orders gives its weight to
 * the others in proportion (the weights present are divided by their sum);
 * the scores are always present once the rating is shown. Fewer published
 * scores than `minReviews` — no rating, «Новый поставщик», whatever the
 * shares (they are still counted and kept).
 */
export function supplierRating(inputs: RatingInputs, rules: RatingRules): SupplierRating {
  const reviewsAverage =
    inputs.reviewsCount > 0 ? inputs.reviewsScoreSum / inputs.reviewsCount : null;
  const minOrders = Math.max(1, rules.minOrders);
  const responseRate =
    inputs.answerRequired >= minOrders ? inputs.answered / inputs.answerRequired : null;
  const onTimeRate = inputs.judged >= minOrders ? inputs.kept / inputs.judged : null;
  const shown = {
    reviewsAverage: reviewsAverage === null ? null : roundTo(reviewsAverage, 2),
    responseRate: responseRate === null ? null : roundTo(responseRate, 4),
    onTimeRate: onTimeRate === null ? null : roundTo(onTimeRate, 4),
  };
  if (reviewsAverage === null || inputs.reviewsCount < Math.max(1, rules.minReviews)) {
    return { score: null, isNew: true, ...shown };
  }
  const parts: { weight: number; value: number }[] = [
    { weight: rules.weights.reviews, value: reviewsAverage },
  ];
  if (responseRate !== null) {
    parts.push({ weight: rules.weights.response_rate, value: shareOnScale(responseRate) });
  }
  if (onTimeRate !== null) {
    parts.push({ weight: rules.weights.deadline_rate, value: shareOnScale(onTimeRate) });
  }
  const weight = parts.reduce((sum, part) => sum + Math.max(0, part.weight), 0);
  const raw =
    weight > 0
      ? parts.reduce((sum, part) => sum + Math.max(0, part.weight) * part.value, 0) / weight
      : reviewsAverage;
  return { score: roundRating(Math.min(5, Math.max(1, raw))), isNew: false, ...shown };
}

/**
 * «Отвечает на N% заявок»: a whole percent, rounded down — 99.6 % is not
 * «100 %», which would promise every order.
 */
export function ratingPercent(share: number): number {
  return Math.floor(Math.min(1, Math.max(0, share)) * 100 + 1e-9);
}

/**
 * The moves of an order after which its supplier's rating is counted again:
 * an answer, a silence, taking it on, a final verdict, an overdue supply.
 * A cancel, a reserve or a no-show change nothing (they judge nobody).
 */
export const ratingOrderActions = [
  "accept",
  "decline",
  "propose_term",
  "propose_time",
  "agree_term",
  "expire_no_response",
  "close",
  "close_late",
  "admin_close",
  "expire_visit",
] as const satisfies readonly OrderAction[];

/** `ratingOrderActions` and the note of an overdue supply (TASK-037). */
export function ratingFollowsOrderEvent(action: string): boolean {
  return action === "supply_overdue" || (ratingOrderActions as readonly string[]).includes(action);
}

/** «Низкий рейтинг»: shown and below the threshold `rating_low_signal`. */
export function ratingIsLow(score: number | null, threshold: number): boolean {
  return score !== null && score < threshold;
}

/**
 * What a recalculation does to the signal «Низкий рейтинг» (SCREENS A-HOME;
 * TASK-050 requirement 4): low and a signal not closed — refresh it; low
 * with none — open one, unless an administrator closed the last one and the
 * rating has stayed low since (the previous snapshot was low too): the
 * administrator dealt with this very fall, so only a new one — a rise and
 * another fall — opens a signal again. A supplier already below a threshold
 * an administrator has just raised gets its signal (nobody has looked at it
 * yet). Not low — close the one open (the fact is over). Never anything
 * else: no automatic block (PRODUCT 13).
 */
export function lowRatingSignalMove(input: {
  previousScore: number | null;
  /** There was a snapshot before this one. */
  hadPrevious: boolean;
  score: number | null;
  threshold: number;
  /** A signal of the supplier is not closed (new or in work). */
  open: boolean;
  /** The latest closed signal of the supplier was closed by an administrator (not by itself). */
  lastClosedByAdmin: boolean;
}): "raise" | "refresh" | "close" | null {
  const low = ratingIsLow(input.score, input.threshold);
  if (!low) {
    return input.open ? "close" : null;
  }
  if (input.open) {
    return "refresh";
  }
  const wasLow = input.hadPrevious && ratingIsLow(input.previousScore, input.threshold);
  return wasLow && input.lastClosedByAdmin ? null : "raise";
}
