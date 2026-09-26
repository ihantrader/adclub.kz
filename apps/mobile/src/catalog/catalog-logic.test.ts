import type { CategoryAttribute, CompatibilityItemResult } from "@adclub/contracts";
import { describe, expect, it } from "vitest";
import type { GarageCar } from "../garage/garage";
import { compatibilityMarkOf, compatibilityView } from "./compatibility-view";
import {
  EMPTY_FILTERS,
  filterCount,
  filtersToQuery,
  setBoolean,
  setRange,
  toggleBrand,
  toggleOption,
} from "./filters";
import { daysBetween, formatTenge, receiptDay } from "./format";
import { vehicleQuery } from "./vehicle-query";

function car(overrides: Partial<GarageCar> = {}): GarageCar {
  return {
    id: "car-1",
    make: { id: "make-1", label: "Geely" },
    model: { id: "model-1", label: "Atlas" },
    year: 2023,
    generation: { id: "gen-1", label: "II" },
    body: { id: "body-1", label: "Внедорожник" },
    engine: { id: "engine-1", label: "JLH-4G20TD" },
    transmission: { id: "tr-1", label: "Автомат" },
    drive: { id: "drive-1", label: "Полный" },
    modificationId: null,
    addedAt: "2026-09-26T10:00:00.000Z",
    ...overrides,
  };
}

describe("the car in a catalog request", () => {
  it("sends nothing when no car is chosen", () => {
    expect(vehicleQuery(null)).toEqual({});
  });

  it("sends the known levels of a car without a single modification", () => {
    expect(vehicleQuery(car())).toEqual({
      vehicleMakeId: "make-1",
      vehicleModelId: "model-1",
      vehicleGenerationId: "gen-1",
      vehicleBodyTypeId: "body-1",
      vehicleEngineId: "engine-1",
      vehicleTransmissionTypeId: "tr-1",
      vehicleDriveTypeId: "drive-1",
      vehicleYear: 2023,
    });
  });

  it("leaves out the levels the car does not have", () => {
    expect(vehicleQuery(car({ engine: null, drive: null, year: null }))).toEqual({
      vehicleMakeId: "make-1",
      vehicleModelId: "model-1",
      vehicleGenerationId: "gen-1",
      vehicleBodyTypeId: "body-1",
      vehicleTransmissionTypeId: "tr-1",
    });
  });

  it("sends the modification alone, with the year, when it is known", () => {
    expect(vehicleQuery(car({ modificationId: "mod-1" }))).toEqual({
      vehicleModificationId: "mod-1",
      vehicleYear: 2023,
    });
  });
});

describe("the compatibility mark", () => {
  const base: CompatibilityItemResult = {
    itemId: "item-1",
    categoryId: "cat-1",
    compatibilityRequired: true,
    hasCompatibility: true,
    result: "fits",
    missing: [],
    mark: "fits",
    listed: true,
    requiresConfirmation: false,
  };

  it("reads the server's mark and nothing else", () => {
    expect(compatibilityView(base)).toEqual({ kind: "fits" });
    // `result` says one thing and `mark` another: the mark is what is shown.
    expect(compatibilityView({ ...base, result: "fits", mark: null })).toEqual({ kind: "none" });
    expect(compatibilityView({ ...base, result: "does_not_fit", mark: "does_not_fit" })).toEqual({
      kind: "doesNotFit",
    });
    expect(compatibilityView({ ...base, mark: "not_specified" })).toEqual({
      kind: "notSpecified",
    });
  });

  it("names the first missing level of «уточните параметр»", () => {
    expect(
      compatibilityView({
        ...base,
        result: "needs_details",
        mark: "needs_details",
        missing: ["engine", "transmission"],
      }),
    ).toEqual({ kind: "needsDetails", level: "engine" });
    expect(
      compatibilityView({ ...base, result: "needs_details", mark: "needs_details", missing: [] }),
    ).toEqual({ kind: "needsDetails", level: null });
  });

  it("falls back to no mark for a value a newer server may add", () => {
    const future = { ...base, mark: "something_new" } as unknown as CompatibilityItemResult;
    expect(compatibilityView(future)).toEqual({ kind: "none" });
  });

  it("maps every case to a design-system mark", () => {
    expect(compatibilityMarkOf({ kind: "fits" })).toBe("fits");
    expect(compatibilityMarkOf({ kind: "needsDetails", level: "engine" })).toBe("missingParameter");
    expect(compatibilityMarkOf({ kind: "doesNotFit" })).toBe("doesNotFit");
    expect(compatibilityMarkOf({ kind: "notSpecified" })).toBe("unknown");
    expect(compatibilityMarkOf({ kind: "none" })).toBeNull();
  });
});

describe("the filters", () => {
  const attributes: CategoryAttribute[] = [
    {
      id: "attr-viscosity",
      code: "viscosity",
      name: { text: "Вязкость", isFallback: false },
      valueType: "enum",
      unit: null,
      number: null,
      options: [],
      isFilterable: true,
      isRequiredForComplete: true,
      sort: 0,
    },
    {
      id: "attr-volume",
      code: "volume",
      name: { text: "Объём", isFallback: false },
      valueType: "number",
      unit: { text: "л", isFallback: false },
      number: null,
      options: [],
      isFilterable: true,
      isRequiredForComplete: false,
      sort: 1,
    },
    {
      id: "attr-hidden",
      code: "hidden",
      name: { text: "Служебная", isFallback: false },
      valueType: "bool",
      unit: null,
      number: null,
      options: [],
      isFilterable: false,
      isRequiredForComplete: false,
      sort: 2,
    },
  ];

  it("counts each section that is set once", () => {
    let state = EMPTY_FILTERS;
    expect(filterCount(state)).toBe(0);
    state = { ...state, availability: "in_stock", onlyMyCity: true };
    state = toggleBrand(toggleBrand(state, "brand-1"), "brand-2");
    state = toggleOption(state, "attr-viscosity", "opt-5w30");
    expect(filterCount(state)).toBe(4);
  });

  it("drops a section that has been emptied again", () => {
    const on = toggleOption(EMPTY_FILTERS, "attr-viscosity", "opt-5w30");
    const off = toggleOption(on, "attr-viscosity", "opt-5w30");
    expect(off.attributes).toEqual({});
    expect(filterCount(off)).toBe(0);
    expect(setRange(EMPTY_FILTERS, "attr-volume", { min: null, max: null }).attributes).toEqual({});
  });

  it("sends brands by comma and the characteristics as one JSON parameter", () => {
    let state = toggleBrand(EMPTY_FILTERS, "brand-1");
    state = toggleBrand(state, "brand-2");
    state = toggleOption(state, "attr-viscosity", "opt-5w30");
    state = setRange(state, "attr-volume", { min: 1, max: 4 });
    state = { ...state, availability: "in_stock", receiving: "pickup", onlyMyCity: true };

    const query = filtersToQuery(state, attributes);
    expect(query.brandIds).toBe("brand-1,brand-2");
    expect(query.availability).toBe("in_stock");
    expect(query.receiving).toBe("pickup");
    expect(query.onlyMyCity).toBe("true");
    expect(JSON.parse(query.attributes ?? "[]")).toEqual([
      { attributeId: "attr-viscosity", optionIds: ["opt-5w30"] },
      { attributeId: "attr-volume", min: 1, max: 4 },
    ]);
  });

  it("puts a range the user entered backwards the right way round", () => {
    const state = setRange(EMPTY_FILTERS, "attr-volume", { min: 10, max: 2 });
    expect(JSON.parse(filtersToQuery(state, attributes).attributes ?? "[]")).toEqual([
      { attributeId: "attr-volume", min: 2, max: 10 },
    ]);
  });

  it("leaves out an attribute the category no longer filters by", () => {
    const state = setBoolean(EMPTY_FILTERS, "attr-hidden", true);
    expect(filtersToQuery(state, attributes).attributes).toBeUndefined();
    // Nothing set at all: an empty query, not empty parameters.
    expect(filtersToQuery(EMPTY_FILTERS, attributes)).toEqual({});
  });

  it("keeps a yes/no filter set to «нет»", () => {
    const state = setBoolean(EMPTY_FILTERS, "attr-volume", false);
    expect(filterCount(state)).toBe(1);
    expect(JSON.parse(filtersToQuery(state, attributes).attributes ?? "[]")).toEqual([
      { attributeId: "attr-volume", value: false },
    ]);
  });
});

describe("prices and receipt dates", () => {
  it("groups a price and keeps the sign next to it", () => {
    expect(formatTenge(12500)).toBe("12 500 ₸");
    expect(formatTenge(990)).toBe("990 ₸");
    expect(formatTenge(1234567)).toBe("1 234 567 ₸");
    expect(formatTenge(0)).toBe("0 ₸");
  });

  it("counts days against the point's own today, not the phone's clock", () => {
    expect(daysBetween("2026-03-13", "2026-03-14")).toBe(1);
    expect(daysBetween("2026-02-28", "2026-03-01")).toBe(1);
    expect(daysBetween("2026-12-31", "2027-01-01")).toBe(1);
    expect(daysBetween("nonsense", "2026-03-14")).toBeNull();
  });

  it("says «сегодня», «завтра» or the date", () => {
    expect(receiptDay("2026-03-13", "2026-03-13")).toEqual({ kind: "today" });
    expect(receiptDay("2026-03-14", "2026-03-13")).toEqual({ kind: "tomorrow" });
    expect(receiptDay("2026-03-16", "2026-03-13")).toEqual({ kind: "date", month: 3, day: 16 });
    expect(receiptDay("2026-03-13", "nonsense")).toEqual({ kind: "date", month: 3, day: 13 });
    expect(receiptDay("", "2026-03-13")).toBeNull();
  });
});
