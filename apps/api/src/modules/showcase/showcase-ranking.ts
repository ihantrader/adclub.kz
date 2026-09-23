import type { ShowcaseListSort, ShowcaseOfferSort, ShowcaseOfferSummary } from "@adclub/contracts";
import { recommendedScore, type RecommendedWeights } from "@adclub/domain";
import { ApiException } from "../../common/errors";
import type { VisibleOffer } from "./showcase-offers";

/**
 * The orders of the catalog (TASK-020; ARCHITECTURE 4.29) over the offers
 * `visibleOffers` gives. «Рекомендуемые» is `recommendedScore` of
 * `@adclub/domain` with the weights of `catalog_recommended_weights`; an
 * item of a list ranks by its best offer. Every order ends with the id, so
 * it is total: equal prices keep one order from page to page.
 *
 * The key of «Рекомендуемые» isn't absolute by itself: the price part is
 * measured against the cheapest offer of the list, and the weights are a
 * setting. So the first page fixes both — the frame (`RankFrame`) — and
 * the cursor carries it: every next page ranks by the very frame of the
 * first (TASK-020.A; ARCHITECTURE 4.30). An item's key then depends only
 * on its own offers, as with «Дешевле» and «Быстрее»: an offer that comes
 * or goes elsewhere, or new weights, move no other item across the
 * cursor. A new list (no cursor) takes the current weights.
 */

type Key = readonly (number | string)[];

function compareKeys(a: Key, b: Key): number {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const left = a[index];
    const right = b[index];
    if (left === right) {
      continue;
    }
    if (left === undefined) {
      return -1;
    }
    if (right === undefined) {
      return 1;
    }
    return left < right ? -1 : 1;
  }
  return 0;
}

function rankedFacts(entry: VisibleOffer, cityId: string | null) {
  return {
    price: entry.price,
    receiptDays: entry.receiptDays,
    inCity: cityId !== null && entry.cityId === cityId,
    verified: entry.verified,
    rating: null,
  };
}

/** The offers of a card in the order asked for. */
export function sortOffers(
  offers: readonly VisibleOffer[],
  sort: ShowcaseOfferSort,
  cityId: string | null,
  weights: RecommendedWeights,
): VisibleOffer[] {
  const reference = Math.min(...offers.map((entry) => entry.price));
  const keyOf = (entry: VisibleOffer): Key => {
    switch (sort) {
      case "cheaper":
        return [entry.price, entry.receipt.date, entry.id];
      case "faster":
        return [entry.receipt.date, entry.price, entry.id];
      default: {
        // `rating`: there are no ratings yet (EPIC-19) — every offer has
        // the same, so the order is «Рекомендуемые».
        const score = recommendedScore(rankedFacts(entry, cityId), reference, weights);
        return [-score, entry.price, entry.receipt.date, entry.id];
      }
    }
  };
  const keyed = offers.map((entry) => ({ entry, key: keyOf(entry) }));
  keyed.sort((a, b) => compareKeys(a.key, b.key));
  return keyed.map(({ entry }) => entry);
}

/** What the offers of an item add up to. */
export function summarize(
  offers: readonly VisibleOffer[],
  cityId: string | null,
): ShowcaseOfferSummary {
  let cheapest = offers[0]!;
  let nearest = offers[0]!;
  for (const entry of offers) {
    if (entry.price < cheapest.price) {
      cheapest = entry;
    }
    if (entry.receipt.date < nearest.receipt.date) {
      nearest = entry;
    }
  }
  return {
    count: offers.length,
    minPrice: cheapest.price,
    currency: "KZT",
    nearestReceipt: nearest.receipt,
    inCity: cityId !== null && offers.some((entry) => entry.cityId === cityId),
    inStock: offers.some((entry) => entry.availability === "in_stock"),
  };
}

export interface RankedItem {
  itemId: string;
  key: Key;
}

/** What «Рекомендуемые» is measured against: fixed by the first page, carried by the cursor. */
export interface RankFrame {
  /** The cheapest price of the list when its first page was given. */
  reference: number;
  weights: RecommendedWeights;
}

/** The frame of a new list: its cheapest offer and the current weights. */
export function rankFrame(
  offersByItem: ReadonlyMap<string, readonly VisibleOffer[]>,
  weights: RecommendedWeights,
): RankFrame {
  let reference = Number.POSITIVE_INFINITY;
  for (const offers of offersByItem.values()) {
    for (const entry of offers) {
      reference = Math.min(reference, entry.price);
    }
  }
  return { reference, weights };
}

/**
 * The items of a list in the order asked for: each item by its offers
 * (those that pass the offer filters). «Рекомендуемые» — the best score of
 * its offers in the frame: the price part measured against the frame's
 * reference, with the frame's weights.
 */
export function rankItems(
  offersByItem: ReadonlyMap<string, readonly VisibleOffer[]>,
  sort: ShowcaseListSort,
  cityId: string | null,
  frame: RankFrame,
): RankedItem[] {
  const { reference, weights } = frame;
  const ranked: RankedItem[] = [];
  for (const [itemId, offers] of offersByItem) {
    const summary = summarize(offers, cityId);
    const nearest = summary.nearestReceipt.date;
    let key: Key;
    switch (sort) {
      case "cheaper":
        key = [summary.minPrice, nearest, itemId];
        break;
      case "faster":
        key = [nearest, summary.minPrice, itemId];
        break;
      default: {
        const best = Math.max(
          ...offers.map((entry) =>
            recommendedScore(rankedFacts(entry, cityId), reference, weights),
          ),
        );
        key = [-best, summary.minPrice, nearest, itemId];
      }
    }
    ranked.push({ itemId, key });
  }
  ranked.sort((a, b) => compareKeys(a.key, b.key));
  return ranked;
}

/**
 * A cursor is the position of the last item shown (its sort key, the id
 * included), the order it belongs to and, for «Рекомендуемые», the frame
 * of the first page: the next page is everything after that position — no
 * item is skipped or repeated, even if items came and went between the
 * pages or the weights changed.
 */
export function encodeListCursor(sort: ShowcaseListSort, key: Key, frame: RankFrame): string {
  const value =
    sort === "recommended"
      ? { s: sort, k: key, f: { p: frame.reference, w: frame.weights } }
      : { s: sort, k: key };
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

const WEIGHT_NAMES = ["price", "receipt", "city", "verified", "rating"] as const;

/** A frame from a cursor, or `null` if it isn't one (the weights as the setting allows them). */
function frameOf(value: unknown): RankFrame | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const { p, w } = value as { p?: unknown; w?: unknown };
  if (typeof p !== "number" || !Number.isFinite(p) || p <= 0) {
    return null;
  }
  if (typeof w !== "object" || w === null) {
    return null;
  }
  const given = w as Record<string, unknown>;
  if (Object.keys(given).length !== WEIGHT_NAMES.length) {
    return null;
  }
  let sum = 0;
  for (const name of WEIGHT_NAMES) {
    const weight = given[name];
    if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0 || weight > 100) {
      return null;
    }
    sum += weight;
  }
  if (sum <= 0) {
    return null;
  }
  return { reference: p, weights: given as unknown as RecommendedWeights };
}

function badCursor(): ApiException {
  const message = "Use the nextCursor of the previous answer, with the same query";
  return new ApiException(400, "VALIDATION_ERROR", message, {
    details: [{ path: "cursor", message }],
  });
}

/**
 * The position of a cursor and, for «Рекомендуемые», its frame (`null` —
 * a cursor given before the frame was carried: the current frame then).
 */
export function decodeListCursor(
  cursor: string,
  sort: ShowcaseListSort,
): { key: Key; frame: RankFrame | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw badCursor();
  }
  const value = parsed as { s?: unknown; k?: unknown; f?: unknown };
  const expectedLength = sort === "recommended" ? 4 : 3;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    value.s !== sort ||
    !Array.isArray(value.k) ||
    value.k.length !== expectedLength ||
    !value.k.every((part) => typeof part === "number" || typeof part === "string")
  ) {
    throw badCursor();
  }
  if (value.f === undefined) {
    return { key: value.k as Key, frame: null };
  }
  const frame = sort === "recommended" ? frameOf(value.f) : null;
  if (!frame) {
    throw badCursor();
  }
  return { key: value.k as Key, frame };
}

/** The items after the cursor's position. */
export function after(ranked: readonly RankedItem[], cursorKey: Key): RankedItem[] {
  return ranked.filter((entry) => compareKeys(entry.key, cursorKey) > 0);
}
