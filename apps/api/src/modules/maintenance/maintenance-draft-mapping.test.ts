import { describe, expect, it } from "vitest";
import { testMaintenanceDraft, type MaintenanceDraftOutput } from "../ai";
import { mapDraft, type DraftCatalogCategory } from "./maintenance-draft-mapping";

const categories: DraftCatalogCategory[] = [
  {
    id: "oils",
    code: "engine_oils",
    kind: "goods",
    attributes: [
      {
        id: "viscosity",
        code: "viscosity",
        type: "enum",
        options: [
          { id: "v0w20", code: "0w_20" },
          { id: "v5w30", code: "5w_30" },
        ],
      },
      { id: "approval", code: "approval", type: "enum", options: [{ id: "sp", code: "api_sp" }] },
      { id: "volume", code: "volume", type: "number", options: [] },
    ],
  },
  { id: "oilFilters", code: "oil_filters", kind: "goods", attributes: [] },
  { id: "oilChange", code: "oil_change", kind: "services", attributes: [] },
];

const item = (patch: Partial<MaintenanceDraftOutput["items"][number]>) => ({
  title: "Моторное масло",
  kind: "part" as const,
  categoryCode: "engine_oils",
  suggestedCategory: null,
  conditions: [],
  intervalKm: 10_000,
  intervalMonths: 12,
  firstKm: null,
  serviceCodes: ["ТО-1"],
  quantity: null,
  ...patch,
});

describe("mapDraft", () => {
  it("maps codes onto the catalog, every element proposed", () => {
    const mapped = mapDraft(
      {
        items: [
          item({
            conditions: [
              { attribute: "viscosity", options: ["5w_30"], min: null, max: null, value: null },
              { attribute: "volume", options: [], min: 4, max: null, value: null },
            ],
          }),
        ],
      },
      categories,
    );
    expect(mapped).toMatchObject({ dropped: 0, unmapped: 0 });
    expect(mapped.elements[0]).toMatchObject({
      status: "proposed",
      target: {
        kind: "category",
        categoryId: "oils",
        attributes: [
          { attributeId: "viscosity", optionIds: ["v5w30"] },
          { attributeId: "volume", min: 4 },
        ],
      },
      note: null,
    });
  });

  it("drops foreign codes and says them in the note", () => {
    const mapped = mapDraft(
      {
        items: [
          item({
            conditions: [
              {
                attribute: "viscosity",
                options: ["5w_30", "15w_60"],
                min: null,
                max: null,
                value: null,
              },
              { attribute: "colour", options: ["red"], min: null, max: null, value: null },
            ],
          }),
          item({
            title: "Тормозная жидкость",
            categoryCode: "brake_fluids",
            suggestedCategory: "Тормозные жидкости",
          }),
          // A service named with a subcategory of goods is not mapped either.
          item({ title: "Замена масла", kind: "service", categoryCode: "engine_oils" }),
        ],
      },
      categories,
    );
    expect(mapped.unmapped).toBe(2);
    expect(mapped.elements[0]!.note).toBe("unmapped: viscosity=15w_60; colour=red");
    expect(mapped.elements[0]!.target).toMatchObject({ attributes: [{ optionIds: ["v5w30"] }] });
    expect(mapped.elements[1]).toMatchObject({
      target: null,
      note: "unmapped: brake_fluids — Тормозные жидкости",
    });
    expect(mapped.elements[2]!.target).toBeNull();
  });

  it("keeps intervals within reason and drops an element without one", () => {
    const mapped = mapDraft(
      {
        items: [
          item({ intervalKm: 500_000, intervalMonths: 0 }),
          item({ intervalKm: 999, intervalMonths: 24, firstKm: 5_000 }),
          item({ intervalKm: 10_000, firstKm: 10_000, quantity: 0, serviceCodes: ["ТО,1", " "] }),
          item({ title: "  " }),
        ],
      },
      categories,
    );
    expect(mapped.dropped).toBe(2);
    expect(mapped.elements[0]).toMatchObject({
      intervalKm: null,
      intervalMonths: 24,
      firstKm: null,
    });
    expect(mapped.elements[1]).toMatchObject({
      intervalKm: 10_000,
      firstKm: null,
      quantity: null,
      serviceCodes: ["ТО1"],
    });
  });

  it("the test provider's draft maps onto the development catalog with one unmapped element", () => {
    const draft = testMaintenanceDraft({
      vehicle: {
        make: "Geely",
        model: "Coolray",
        generation: null,
        yearFrom: null,
        yearTo: null,
        engine: { code: "JLH-3G15TD", displacementL: 1.5, fuel: "Бензин", powerHp: 177 },
      },
      horizonKm: 60_000,
      categories: [],
    });
    const titles = draft.items.map((entry) => entry.title);
    expect(titles).toContain("Свечи зажигания");
    expect(
      draft.items.find((entry) => entry.title === "Компьютерная диагностика")!.serviceCodes,
    ).toEqual(["ТО-2", "ТО-4"]);
    expect(draft.items.filter((entry) => entry.categoryCode === "brake_fluids")).toHaveLength(1);
    const diesel = testMaintenanceDraft({
      vehicle: {
        make: "Geely",
        model: null,
        generation: null,
        yearFrom: null,
        yearTo: null,
        engine: { code: "D", displacementL: 2, fuel: "Дизель", powerHp: null },
      },
      horizonKm: 60_000,
      categories: [],
    });
    expect(diesel.items.map((entry) => entry.title)).not.toContain("Свечи зажигания");
  });
});
