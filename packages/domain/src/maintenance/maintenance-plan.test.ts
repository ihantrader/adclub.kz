import { describe, expect, it } from "vitest";
import {
  ageMonthsFromYear,
  dueMaintenance,
  maintenanceIntervalsProblem,
  maintenancePlanFor,
  maintenanceScopeMatches,
  type MaintenanceCar,
  type MaintenanceElement,
  type MaintenanceScope,
  type PlanCandidate,
} from "./maintenance-plan";

const scope = (patch: Partial<MaintenanceScope> = {}): MaintenanceScope => ({
  makeId: "geely",
  modelId: null,
  generationId: null,
  engineId: null,
  ...patch,
});

const car = (patch: Partial<MaintenanceCar> = {}): MaintenanceCar => ({
  makeId: "geely",
  modelId: null,
  generationId: null,
  engineId: null,
  ...patch,
});

describe("maintenanceScopeMatches", () => {
  it.each([
    [
      "the make only, any car of the make",
      scope(),
      car({ modelId: "coolray" }),
      { result: "fits" },
    ],
    ["another make", scope(), car({ makeId: "chery" }), { result: "does_not_fit" }],
    [
      "the model of the car",
      scope({ modelId: "coolray" }),
      car({ modelId: "coolray", engineId: "e" }),
      { result: "fits" },
    ],
    [
      "another model",
      scope({ modelId: "coolray" }),
      car({ modelId: "atlas" }),
      { result: "does_not_fit" },
    ],
    [
      "the engine the car does not say",
      scope({ modelId: "coolray", engineId: "jlh3g15" }),
      car({ modelId: "coolray" }),
      { result: "needs_details", missing: ["engine"] },
    ],
    [
      "two levels unknown",
      scope({ modelId: "atlas", generationId: "ii", engineId: "e" }),
      car({ modelId: "atlas" }),
      { result: "needs_details", missing: ["generation", "engine"] },
    ],
    [
      "a contradiction beats a missing level",
      scope({ modelId: "atlas", engineId: "e" }),
      car({ modelId: "coolray" }),
      { result: "does_not_fit" },
    ],
    [
      "a car without a make",
      scope(),
      car({ makeId: null }),
      { result: "needs_details", missing: ["make"] },
    ],
  ])("%s", (_name, planScope, theCar, expected) => {
    expect(maintenanceScopeMatches(planScope, theCar)).toEqual(expected);
  });
});

describe("maintenancePlanFor", () => {
  const plan = (
    id: string,
    planScope: MaintenanceScope,
    status: PlanCandidate["status"] = "active",
  ) => ({
    id,
    status,
    scope: planScope,
  });
  const make = plan("make", scope());
  const model = plan("model", scope({ modelId: "coolray" }));
  const engine = plan("engine", scope({ modelId: "coolray", engineId: "jlh3g15" }));
  const generationEngine = plan(
    "generation-engine",
    scope({ modelId: "atlas", generationId: "ii", engineId: "jlh4g20" }),
  );

  it.each([
    [
      "the most specific of the fitting ones",
      car({ modelId: "coolray", engineId: "jlh3g15" }),
      [make, model, engine],
      "engine",
    ],
    [
      "the engine is not known: the model's",
      car({ modelId: "coolray" }),
      [make, model, engine],
      "model",
    ],
    // Edge case: no engine, a general plan of the make and one of the generation needing the engine.
    [
      "no engine: the make's, the generation's does not block",
      car({ modelId: "atlas", generationId: "ii" }),
      [make, generationEngine],
      "make",
    ],
    [
      "drafts and archived plans never apply",
      car({ modelId: "coolray" }),
      [plan("d", scope({ modelId: "coolray" }), "draft"), plan("a", scope(), "archived"), make],
      "make",
    ],
  ])("%s", (_name, theCar, plans, expected) => {
    const choice = maintenancePlanFor(theCar, plans);
    expect(choice.kind === "plan" ? choice.plan.id : choice.kind).toBe(expected);
  });

  it("asks for the levels when nothing fits without them", () => {
    expect(maintenancePlanFor(car({ modelId: "atlas" }), [generationEngine])).toEqual({
      kind: "needs_details",
      missing: ["generation", "engine"],
    });
  });

  it("asks for the fewest levels of the plans that need the fewest", () => {
    const byEngine = plan("by-engine", scope({ modelId: "atlas", engineId: "jlh4g20" }));
    expect(maintenancePlanFor(car({ modelId: "atlas" }), [generationEngine, byEngine])).toEqual({
      kind: "needs_details",
      missing: ["engine"],
    });
  });

  it("no plan of the make at all", () => {
    expect(maintenancePlanFor(car({ makeId: "chery" }), [make, model])).toEqual({
      kind: "no_plan",
    });
    expect(maintenancePlanFor(car(), [plan("d", scope(), "draft")])).toEqual({ kind: "no_plan" });
  });
});

describe("dueMaintenance", () => {
  let position = 0;
  const element = (id: string, patch: Partial<MaintenanceElement> = {}): MaintenanceElement => ({
    id,
    position: position++,
    intervalKm: null,
    intervalMonths: null,
    firstKm: null,
    firstMonths: null,
    serviceCodes: [],
    ...patch,
  });
  const oil = element("oil", {
    intervalKm: 10_000,
    intervalMonths: 12,
    serviceCodes: ["ТО-1", "ТО-2", "ТО-3", "ТО-4"],
  });
  const air = element("air", { intervalKm: 20_000, serviceCodes: ["ТО-2", "ТО-4"] });
  const fluid = element("fluid", {
    intervalKm: 40_000,
    intervalMonths: 24,
    serviceCodes: ["ТО-4"],
  });
  const diagnostics = element("diagnostics", {
    intervalKm: 20_000,
    serviceCodes: ["ТО-2", "ТО-4"],
  });
  const firstEarly = element("first-early", { intervalKm: 10_000, firstKm: 5_000 });
  const plan = [oil, air, fluid, diagnostics];
  const ids = (answer: { items: { element: MaintenanceElement }[] }) =>
    answer.items.map((entry) => entry.element.id);

  it.each([
    // Edge case: exactly at 20 000 — ТО-2 is due (inclusive), the next one is 30 000.
    ["exactly on the interval", 20_000, ["oil", "air", "diagnostics"], 20_000, 30_000],
    ["between the intervals", 15_000, ["oil", "air", "diagnostics"], 20_000, 30_000],
    ["just after a service", 20_001, ["oil"], 30_000, 40_000],
    ["at 40 000 — everything", 40_000, ["oil", "air", "fluid", "diagnostics"], 40_000, 50_000],
    // Edge case: 125 000 — the multiples go on, 130 000 is the nearest.
    ["far past the horizon of the plan", 125_000, ["oil"], 130_000, 140_000],
    ["a new car", 0, ["oil"], 10_000, 20_000],
  ])("%s (%i km)", (_name, mileageKm, expected, serviceKm, nextServiceKm) => {
    const answer = dueMaintenance(plan, { mileageKm });
    expect(ids(answer)).toEqual(expected);
    expect(answer.serviceKm).toBe(serviceKm);
    expect(answer.nextServiceKm).toBe(nextServiceKm);
    expect(answer.items.every((entry) => entry.reason === "by_km")).toBe(true);
    expect(answer.items.every((entry) => entry.atKm === serviceKm)).toBe(true);
  });

  it("an element beyond the next service is not due (the horizon)", () => {
    expect(ids(dueMaintenance(plan, { mileageKm: 21_000 }))).not.toContain("fluid");
  });

  it("by the code: the elements of that service, whatever the mileage", () => {
    const answer = dueMaintenance(plan, { serviceCode: "ТО-2", mileageKm: 3_000 });
    expect(ids(answer)).toEqual(["oil", "air", "diagnostics"]);
    expect(answer.items.every((entry) => entry.reason === "by_code" && entry.atKm === null)).toBe(
      true,
    );
    expect(ids(dueMaintenance(plan, { serviceCode: "то-4" }))).toEqual([
      "oil",
      "air",
      "fluid",
      "diagnostics",
    ]);
    expect(ids(dueMaintenance(plan, { serviceCode: "ТО-9" }))).toEqual([]);
  });

  it("no mileage and no code: «уточните пробег»", () => {
    expect(dueMaintenance(plan, {})).toEqual({
      items: [],
      serviceKm: null,
      nextServiceKm: null,
      reason: "mileage_required",
    });
    // An age alone does not say which service it is.
    expect(dueMaintenance(plan, { ageMonths: 30 }).reason).toBe("mileage_required");
  });

  it("the first time earlier than the interval", () => {
    const answer = dueMaintenance([firstEarly], { mileageKm: 3_000 });
    expect(answer.items).toEqual([
      { element: firstEarly, reason: "first", atKm: 5_000, atMonths: null },
    ]);
    // Past the first time — the multiples of the interval.
    expect(dueMaintenance([firstEarly], { mileageKm: 6_000 }).items[0]).toMatchObject({
      reason: "by_km",
      atKm: 10_000,
    });
    // Edge case: 125 000 — the first time is long gone.
    expect(dueMaintenance([firstEarly], { mileageKm: 125_000 }).items[0]).toMatchObject({
      reason: "by_km",
      atKm: 130_000,
    });
  });

  it("by the months, when the age is known: whichever comes first", () => {
    // 21 000 km: the brake fluid (40 000 / 24 мес) is not due by km, but a
    // 23-month-old car reaches 24 months before the next km step.
    const answer = dueMaintenance(plan, { mileageKm: 21_000, ageMonths: 23 });
    expect(answer.items.find((entry) => entry.element.id === "fluid")).toMatchObject({
      reason: "by_months",
      atMonths: 24,
    });
    // A year-old car: the next service by months is at 12, the fluid's at 24.
    expect(ids(dueMaintenance(plan, { mileageKm: 21_000, ageMonths: 1 }))).toEqual(["oil"]);
  });

  it("the last time done moves the next one a whole interval on", () => {
    const answer = dueMaintenance(plan, {
      mileageKm: 15_000,
      lastDone: [{ elementId: "air", atKm: 18_000 }],
    });
    expect(ids(answer)).toEqual(["oil", "diagnostics"]);
    // Done long ago: overdue, still due now, at the mileage it was due at.
    const overdue = dueMaintenance(plan, {
      mileageKm: 15_000,
      lastDone: [{ elementId: "oil", atKm: 0 }],
    });
    expect(overdue.items[0]).toMatchObject({ reason: "by_km", atKm: 10_000 });
    expect(ids(overdue)[0]).toBe("oil");
  });

  it("a plan without km intervals answers nothing by the mileage", () => {
    const monthsOnly = element("months", { intervalMonths: 24 });
    const answer = dueMaintenance([monthsOnly], { mileageKm: 10_000 });
    expect(answer).toMatchObject({ items: [], serviceKm: null, nextServiceKm: null, reason: null });
  });
});

describe("ageMonthsFromYear", () => {
  it.each([
    [2024, { year: 2026, month: 11 }, 23],
    [2026, { year: 2026, month: 11 }, 0],
    [2025, { year: 2026, month: 1 }, 1],
  ])("%i in %o", (year, now, expected) => {
    expect(ageMonthsFromYear(year, now)).toBe(expected);
  });
});

describe("maintenanceIntervalsProblem", () => {
  const intervals = (patch: Partial<Parameters<typeof maintenanceIntervalsProblem>[0]>) => ({
    intervalKm: null,
    intervalMonths: null,
    firstKm: null,
    firstMonths: null,
    ...patch,
  });
  it.each([
    [intervals({ intervalKm: 10_000 }), null],
    [intervals({ intervalMonths: 24 }), null],
    [intervals({}), "interval_required"],
    [intervals({ intervalKm: 999 }), "km_range"],
    [intervals({ intervalKm: 120_001 }), "km_range"],
    [intervals({ intervalKm: 120_000, intervalMonths: 121 }), "months_range"],
    [intervals({ intervalKm: 10_000, firstKm: 10_000 }), "first_km"],
    [intervals({ intervalMonths: 12, firstKm: 5_000 }), "first_km"],
    [intervals({ intervalKm: 10_000, firstKm: 5_000 }), null],
    [intervals({ intervalMonths: 12, firstMonths: 12 }), "first_months"],
  ])("%o → %s", (input, expected) => {
    expect(maintenanceIntervalsProblem(input)).toBe(expected);
  });
});
