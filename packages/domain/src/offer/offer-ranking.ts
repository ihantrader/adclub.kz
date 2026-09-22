/**
 * The order of offers and of catalog items by their offers (PRODUCT 6.3,
 * 9; SCREENS M-CAT-02, M-CAT-07; ARCHITECTURE 4.29; TASK-020). One pure
 * function for the list of a subcategory and for the offers of an item,
 * so «Рекомендуемые» means the same everywhere.
 *
 * «Рекомендуемые» is not the price alone: a weighted sum of what a user
 * gains from an offer, each part between 0 and 1:
 *
 * - price: the cheapest price of the set divided by this price (1 — the
 *   cheapest, 0.5 — twice as dear);
 * - receipt: 1 / (1 + days until the receipt date) — today 1, tomorrow
 *   0.5, in three days 0.25;
 * - city: 1 when the offer is in the chosen city, 0 otherwise or with
 *   «весь Казахстан»;
 * - verified: 1 for a «проверенный партнёр»;
 * - rating: the rating out of 5 divided by 5; 0 while there is none
 *   (ratings come with EPIC-19, every offer counts the same until then).
 *
 * The weights are a setting (`catalog_recommended_weights`), changed
 * without a release. Ties are broken by the price, then the date, then the
 * id — the order is total and stable between pages.
 */

export interface RecommendedWeights {
  price: number;
  receipt: number;
  city: number;
  verified: number;
  rating: number;
}

export interface RankedOfferFacts {
  /** Whole tenge, above 0. */
  price: number;
  /** Calendar days from the day of the confirmation to the receipt date (0 — today). */
  receiptDays: number;
  inCity: boolean;
  verified: boolean;
  /** Out of 5; `null` — no rating yet. */
  rating: number | null;
}

/** Calendar days from `from` to `to` (`YYYY-MM-DD`), never below 0. */
export function daysBetween(from: string, to: string): number {
  const day = (date: string) => {
    const [year = 0, month = 1, dayOfMonth = 1] = date.split("-").map(Number);
    return Date.UTC(year, month - 1, dayOfMonth) / 86_400_000;
  };
  return Math.max(0, Math.round(day(to) - day(from)));
}

/**
 * The «Рекомендуемые» score of an offer; `referencePrice` — the cheapest
 * price of the set it is ranked in (the item's offers, or every offer of
 * the list).
 */
export function recommendedScore(
  facts: RankedOfferFacts,
  referencePrice: number,
  weights: RecommendedWeights,
): number {
  const price = facts.price > 0 ? Math.min(1, referencePrice / facts.price) : 0;
  const receipt = 1 / (1 + Math.max(0, facts.receiptDays));
  const rating = facts.rating === null ? 0 : Math.min(1, Math.max(0, facts.rating / 5));
  return (
    weights.price * price +
    weights.receipt * receipt +
    weights.city * (facts.inCity ? 1 : 0) +
    weights.verified * (facts.verified ? 1 : 0) +
    weights.rating * rating
  );
}
