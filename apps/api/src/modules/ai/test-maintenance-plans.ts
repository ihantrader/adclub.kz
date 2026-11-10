import type { MaintenanceDraftInput, MaintenanceDraftOutput } from "./ai-gateway";

/**
 * The draft maintenance plan the test AI provider «makes» (TASK-061):
 * deterministic data of code, plainly a stand-in for a model, in the codes
 * of the development catalog (`dev:catalog:seed`), for development, tests
 * and CI. A petrol car gets oil and its filter every 10 000 km / 12 months,
 * the air and cabin filters at 20 000, the brake fluid at 40 000 / 24
 * months, spark plugs at 40 000 and the computer diagnostics at ТО-2 and
 * ТО-4; a diesel one — the same without the plugs. One element names a
 * subcategory the catalog has not (`brake_fluids`), so the «unmapped» path
 * is seen; and the oil keeps to 5W-30 API SP — the oil the development data
 * sells for the Coolray (Shell Helix HX8), so a check shows it on offer.
 */

type DraftItem = MaintenanceDraftOutput["items"][number];

const codes = (step: number, horizonKm: number): string[] => {
  const result: string[] = [];
  for (let km = step; km <= horizonKm; km += step) {
    result.push(`ТО-${String(km / 10_000)}`);
  }
  return result;
};

const item = (patch: Partial<DraftItem> & Pick<DraftItem, "title" | "kind">): DraftItem => ({
  categoryCode: null,
  suggestedCategory: null,
  conditions: [],
  intervalKm: null,
  intervalMonths: null,
  firstKm: null,
  serviceCodes: [],
  quantity: null,
  ...patch,
});

export function testMaintenanceDraft(input: MaintenanceDraftInput): MaintenanceDraftOutput {
  const horizon = input.horizonKm;
  const fuel = input.vehicle.engine?.fuel?.toLowerCase() ?? "";
  const diesel = fuel.includes("диз") || fuel.includes("diesel");
  const items: DraftItem[] = [
    item({
      title: "Моторное масло",
      kind: "part",
      categoryCode: "engine_oils",
      conditions: [
        { attribute: "viscosity", options: ["5w_30"], min: null, max: null, value: null },
        { attribute: "approval", options: ["api_sp"], min: null, max: null, value: null },
      ],
      intervalKm: 10_000,
      intervalMonths: 12,
      serviceCodes: codes(10_000, horizon),
    }),
    item({
      title: "Масляный фильтр",
      kind: "part",
      categoryCode: "oil_filters",
      intervalKm: 10_000,
      intervalMonths: 12,
      serviceCodes: codes(10_000, horizon),
    }),
    item({
      title: "Замена моторного масла",
      kind: "service",
      categoryCode: "oil_change",
      intervalKm: 10_000,
      intervalMonths: 12,
      serviceCodes: codes(10_000, horizon),
    }),
    item({
      title: "Воздушный фильтр",
      kind: "part",
      categoryCode: "air_filters",
      intervalKm: 20_000,
      serviceCodes: codes(20_000, horizon),
    }),
    item({
      title: "Салонный фильтр",
      kind: "part",
      categoryCode: "cabin_filters",
      intervalKm: 20_000,
      intervalMonths: 12,
      serviceCodes: codes(20_000, horizon),
    }),
    item({
      title: "Тормозная жидкость",
      kind: "part",
      categoryCode: "brake_fluids",
      suggestedCategory: "Тормозные жидкости",
      intervalKm: 40_000,
      intervalMonths: 24,
      serviceCodes: codes(40_000, horizon),
    }),
    ...(diesel
      ? []
      : [
          item({
            title: "Свечи зажигания",
            kind: "part",
            categoryCode: "spark_plugs",
            intervalKm: 40_000,
            serviceCodes: codes(40_000, horizon),
            quantity: 4,
          }),
        ]),
    item({
      title: "Компьютерная диагностика",
      kind: "service",
      categoryCode: "computer_diagnostics",
      intervalKm: 20_000,
      serviceCodes: codes(20_000, horizon).filter((code) => code === "ТО-2" || code === "ТО-4"),
    }),
  ];
  return { items };
}
