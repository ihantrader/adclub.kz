import type { CompatibilityLevel, CompatibilityResult } from "@adclub/contracts";
import { describe, expect, it } from "vitest";
import { displayOf, itemResultOf, verdictOf, type RecordFacts } from "./compatibility-rules";

/**
 * The rules that turn what the records say about a car into the answer
 * (TASK-015 requirement 4, D-029). The comparison of records with cars —
 * levels, years, several records — is covered on a real database by the
 * case table of `compatibility.integration.test.ts`.
 */

describe("verdictOf", () => {
  const cases: [string, RecordFacts, CompatibilityResult, CompatibilityLevel[]][] = [
    ["no records", { records: 0, fits: false, missing: null }, "not_specified", []],
    ["a record fits", { records: 1, fits: true, missing: [] }, "fits", []],
    [
      "fits beats needing details (another record needs the engine)",
      { records: 2, fits: true, missing: [] },
      "fits",
      [],
    ],
    [
      "a record needs the engine",
      { records: 1, fits: false, missing: ["engine"] },
      "needs_details",
      ["engine"],
    ],
    [
      "missing levels come in the order a client asks for them",
      { records: 2, fits: false, missing: ["year", "engine", "generation"] },
      "needs_details",
      ["generation", "engine", "year"],
    ],
    [
      "every record contradicts the car",
      { records: 3, fits: false, missing: null },
      "does_not_fit",
      [],
    ],
  ];
  it.each(cases)("%s", (_name, facts, result, missing) => {
    expect(verdictOf(facts)).toEqual({ result, missing });
  });
});

describe("displayOf (D-029)", () => {
  type Row = [
    string,
    CompatibilityResult | null,
    boolean,
    boolean,
    { mark: CompatibilityResult | null; listed: boolean; requiresConfirmation: boolean },
  ];
  const listed = (mark: CompatibilityResult | null) => ({
    mark,
    listed: true,
    requiresConfirmation: false,
  });
  const cases: Row[] = [
    // Compulsory compatibility, a car chosen.
    ["compulsory + car: fits", "fits", true, true, listed("fits")],
    ["compulsory + car: needs details", "needs_details", true, true, listed("needs_details")],
    [
      "compulsory + car: does not fit — hidden, warned",
      "does_not_fit",
      true,
      true,
      { mark: "does_not_fit", listed: false, requiresConfirmation: true },
    ],
    [
      "compulsory + car: not specified — hidden",
      "not_specified",
      true,
      true,
      { mark: "not_specified", listed: false, requiresConfirmation: false },
    ],
    // Compulsory compatibility, no car.
    [
      "compulsory, no car: not specified — shown, marked",
      "not_specified",
      true,
      false,
      listed("not_specified"),
    ],
    ["compulsory, no car: with records — shown, unmarked", null, true, false, listed(null)],
    // A universal subcategory, a car chosen.
    ["universal + car: fits", "fits", false, true, listed("fits")],
    ["universal + car: needs details", "needs_details", false, true, listed("needs_details")],
    [
      "universal + car: does not fit — hidden from lists here too",
      "does_not_fit",
      false,
      true,
      { mark: "does_not_fit", listed: false, requiresConfirmation: true },
    ],
    [
      "universal + car: no records — shown without a mark",
      "not_specified",
      false,
      true,
      listed(null),
    ],
    // A universal subcategory, no car.
    ["universal, no car: no records", "not_specified", false, false, listed(null)],
    ["universal, no car: with records", null, false, false, listed(null)],
  ];
  it.each(cases)("%s", (_name, result, compatibilityRequired, vehicleGiven, expected) => {
    expect(displayOf({ result, compatibilityRequired, vehicleGiven })).toEqual(expected);
  });
});

describe("itemResultOf", () => {
  const base = { itemId: "i", categoryId: "c", compatibilityRequired: true };

  it("without a car tells only whether there are records", () => {
    expect(
      itemResultOf({
        ...base,
        vehicleGiven: false,
        facts: { records: 2, fits: false, missing: ["make"] },
      }),
    ).toMatchObject({
      hasCompatibility: true,
      result: null,
      missing: [],
      mark: null,
      listed: true,
    });
    expect(
      itemResultOf({
        ...base,
        vehicleGiven: false,
        facts: { records: 0, fits: false, missing: null },
      }),
    ).toMatchObject({
      hasCompatibility: false,
      result: "not_specified",
      mark: "not_specified",
      listed: true,
    });
  });

  it("with a car gives the result, the missing levels and the display", () => {
    expect(
      itemResultOf({
        ...base,
        vehicleGiven: true,
        facts: { records: 1, fits: false, missing: ["engine"] },
      }),
    ).toEqual({
      ...base,
      hasCompatibility: true,
      result: "needs_details",
      missing: ["engine"],
      mark: "needs_details",
      listed: true,
      requiresConfirmation: false,
    });
  });
});
