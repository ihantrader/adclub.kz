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

/**
 * The items of a list in the order asked for: each item by its offers
 * (those that pass the offer filters). «Рекомендуемые» — the best score of
 * its offers, the price part measured against the cheapest offer of the
 * whole list.
 */
export function rankItems(
  offersByItem: ReadonlyMap<string, readonly VisibleOffer[]>,
  sort: ShowcaseListSort,
  cityId: string | null,
  weights: RecommendedWeights,
): RankedItem[] {
  let reference = Number.POSITIVE_INFINITY;
  for (const offers of offersByItem.values()) {
    for (const entry of offers) {
      reference = Math.min(reference, entry.price);
    }
  }
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
 * included) and the order it belongs to: the next page is everything after
 * that position — no item is skipped or repeated, even if items came and
 * went between the pages.
 */
export function encodeListCursor(sort: ShowcaseListSort, key: Key): string {
  return Buffer.from(JSON.stringify({ s: sort, k: key }), "utf8").toString("base64url");
}

function badCursor(): ApiException {
  const message = "Use the nextCursor of the previous answer, with the same query";
  return new ApiException(400, "VALIDATION_ERROR", message, {
    details: [{ path: "cursor", message }],
  });
}

export function decodeListCursor(cursor: string, sort: ShowcaseListSort): Key {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw badCursor();
  }
  const value = parsed as { s?: unknown; k?: unknown };
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
  return value.k as Key;
}

/** The items after the cursor's position. */
export function after(ranked: readonly RankedItem[], cursorKey: Key): RankedItem[] {
  return ranked.filter((entry) => compareKeys(entry.key, cursorKey) > 0);
}
