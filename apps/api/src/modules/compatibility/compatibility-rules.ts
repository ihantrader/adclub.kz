import type {
  CompatibilityItemResult,
  CompatibilityLevel,
  CompatibilityResult,
} from "@adclub/contracts";

/**
 * The rules of compatibility that don't need the database (ARCHITECTURE
 * 4.25): the result of an item from what its records say about the car,
 * and how a client shows the item (D-029). The comparison of each record
 * with the car runs in the database for all the items at once
 * (`compatibility-evaluator.ts`); these functions turn its per-item facts
 * into the answer. The evaluator is the only caller: every consumer — the
 * check route now, the client catalog and the garage later — goes through
 * `CompatibilityEvaluator`, so there is one calculation.
 */

/** The levels in the order a client asks to fill them in (the contract's order). */
export const LEVEL_ORDER: readonly CompatibilityLevel[] = [
  "make",
  "model",
  "generation",
  "body",
  "engine",
  "transmission",
  "drive",
  "year",
];

/** What the records of one item say about one car, as the database counted it. */
export interface RecordFacts {
  /** Approved records of the item. */
  records: number;
  /** A record matches the car on every level it names, the year included. */
  fits: boolean;
  /**
   * The levels missing from the car for the records that don't contradict
   * it and need the fewest levels (all of them when several need as few);
   * `null` — every record contradicts the car (or there are none).
   */
  missing: readonly CompatibilityLevel[] | null;
}

export interface Verdict {
  result: CompatibilityResult;
  missing: CompatibilityLevel[];
}

/**
 * The result for a car (TASK-015 requirement 4): «fits» beats «needs
 * details», which beats «does not fit»; no approved records — «not
 * specified».
 */
export function verdictOf(facts: RecordFacts): Verdict {
  if (facts.records === 0) {
    return { result: "not_specified", missing: [] };
  }
  if (facts.fits) {
    return { result: "fits", missing: [] };
  }
  if (facts.missing && facts.missing.length > 0) {
    const wanted = new Set(facts.missing);
    return {
      result: "needs_details",
      missing: LEVEL_ORDER.filter((level) => wanted.has(level)),
    };
  }
  return { result: "does_not_fit", missing: [] };
}

export interface Display {
  mark: CompatibilityResult | null;
  listed: boolean;
  requiresConfirmation: boolean;
}

/**
 * How a client shows an item (D-029, PRODUCT 7.5), kept apart from the
 * result:
 * - a subcategory with compulsory compatibility: with a car chosen, lists
 *   show «fits» and «needs details»; «does not fit» and «not specified»
 *   are hidden. Without a car everything is shown, «not specified» marked;
 * - a universal subcategory: always shown; marked by the result when the
 *   item has records, unmarked when it has none;
 * - «does not fit» is never in a list; opened directly it is shown with a
 *   warning and needs the user's confirmation for a request.
 */
export function displayOf(input: {
  result: CompatibilityResult | null;
  compatibilityRequired: boolean;
  vehicleGiven: boolean;
}): Display {
  const { result, compatibilityRequired, vehicleGiven } = input;
  if (!vehicleGiven) {
    return {
      mark: compatibilityRequired && result === "not_specified" ? "not_specified" : null,
      listed: true,
      requiresConfirmation: false,
    };
  }
  if (result === "does_not_fit") {
    return { mark: "does_not_fit", listed: false, requiresConfirmation: true };
  }
  if (result === "not_specified") {
    return compatibilityRequired
      ? { mark: "not_specified", listed: false, requiresConfirmation: false }
      : { mark: null, listed: true, requiresConfirmation: false };
  }
  return { mark: result, listed: true, requiresConfirmation: false };
}

/** The answer for one item: the result for the car (if any) and how to show it. */
export function itemResultOf(input: {
  itemId: string;
  categoryId: string;
  compatibilityRequired: boolean;
  facts: RecordFacts;
  vehicleGiven: boolean;
}): CompatibilityItemResult {
  const hasCompatibility = input.facts.records > 0;
  // Without a car only «no records» can be told; records have nothing to
  // be compared with.
  const verdict: Verdict | null =
    input.vehicleGiven || !hasCompatibility ? verdictOf(input.facts) : null;
  const display = displayOf({
    result: verdict?.result ?? null,
    compatibilityRequired: input.compatibilityRequired,
    vehicleGiven: input.vehicleGiven,
  });
  return {
    itemId: input.itemId,
    categoryId: input.categoryId,
    compatibilityRequired: input.compatibilityRequired,
    hasCompatibility,
    result: verdict?.result ?? null,
    missing: verdict?.missing ?? [],
    ...display,
  };
}
