import { ApiError } from "@adclub/api-client";
import { describe, expect, it } from "vitest";
import {
  activePlanOf,
  catalogCountText,
  codesOf,
  conditionNumberOf,
  conditionText,
  currentConditions,
  firstText,
  intervalText,
  maintenanceErrorText,
  notReadyLines,
  numberOf,
  scopeLabelText,
} from "./maintenance-words";

const refusal = (status: number, code: string, details?: unknown) =>
  new ApiError({ status, code: code as never, message: "x", details, retryable: false });

/** The numbers are grouped with a no-break space; the tests read it as a space. */
const plain = (text: string | null) => text?.replace(/[\u00a0\u202f]/gu, " ") ?? null;

describe("maintenance words", () => {
  it("the area in one line", () => {
    expect(
      scopeLabelText({
        make: "Geely",
        model: "Atlas",
        generation: "II (FX11) (с 2023)",
        engine: null,
      }),
    ).toBe("Geely · Atlas · II (FX11) (с 2023)");
    expect(scopeLabelText({ make: "Geely", model: null, generation: null, engine: null })).toBe(
      "Geely",
    );
  });

  it("the intervals", () => {
    expect(plain(intervalText({ intervalKm: 10_000, intervalMonths: 12 }))).toBe(
      "каждые 10 000 км / 12 мес",
    );
    expect(plain(intervalText({ intervalKm: null, intervalMonths: 24 }))).toBe("каждые 24 мес");
    expect(plain(firstText({ firstKm: 5_000, firstMonths: null }))).toBe("первый раз — 5 000 км");
    expect(plain(firstText({ firstKm: null, firstMonths: null }))).toBeNull();
  });

  it("the counts of a check", () => {
    expect(catalogCountText(3, 1, false)).toBe("в справочнике 3 · в продаже 1");
    expect(catalogCountText(0, 0, false)).toBe("в справочнике 0 · в продаже 0");
    expect(catalogCountText(0, 0, false, true)).toBe("правило не действует · в продаже 0");
    expect(catalogCountText(2, null, true)).toBe("в справочнике 2 · в продаже — выберите город");
  });

  it("codes and numbers typed", () => {
    expect(codesOf("ТО-1, ТО-2;то-2\nТО-4,")).toEqual(["ТО-1", "ТО-2", "ТО-4"]);
    expect(numberOf("10 000")).toBe(10_000);
    expect(numberOf("")).toBeNull();
    expect(numberOf("10к")).toBeUndefined();
  });

  it("reads a «от/до» bound as typed: a comma or a point, a minus, a unit (TASK-061.A)", () => {
    expect(conditionNumberOf("4,5")).toBe(4.5);
    expect(conditionNumberOf("4.5")).toBe(4.5);
    expect(conditionNumberOf("4,5 л")).toBe(4.5);
    expect(conditionNumberOf(" 4 ")).toBe(4);
    expect(conditionNumberOf("-1")).toBe(-1);
    expect(conditionNumberOf("−1,5")).toBe(-1.5);
    expect(conditionNumberOf("4,")).toBe(4);
    expect(conditionNumberOf(",5")).toBe(0.5);
    expect(conditionNumberOf("1 000")).toBe(1000);
    expect(conditionNumberOf("")).toBeNull();
    expect(conditionNumberOf("   ")).toBeNull();
    expect(conditionNumberOf("-")).toBeUndefined();
    expect(conditionNumberOf("л")).toBeUndefined();
    expect(conditionNumberOf("4,5,6")).toBeUndefined();
    expect(conditionNumberOf("4-5")).toBeUndefined();
    expect(conditionText(4.5)).toBe("4,5");
    expect(conditionText(-1)).toBe("-1");
    expect(conditionText(undefined)).toBe("");
  });

  it("drops the conditions the catalog no longer has, and says so (TASK-061.A)", () => {
    const attributes = [
      { id: "visc", name: "Вязкость", usable: false, activeOptionIds: ["0w20"] },
      { id: "spec", name: "Допуск", usable: true, activeOptionIds: ["sp"] },
      { id: "vol", name: "Объём", usable: true, activeOptionIds: [] },
    ];
    expect(
      currentConditions(
        [
          { attributeId: "visc", optionIds: ["0w20"] },
          { attributeId: "spec", optionIds: ["sp", "sn"] },
          { attributeId: "vol", min: 4 },
          { attributeId: "gone", value: true },
        ],
        attributes,
      ),
    ).toEqual({
      kept: [
        { attributeId: "spec", optionIds: ["sp"] },
        { attributeId: "vol", min: 4 },
      ],
      removed: [
        "Условие «Вязкость» больше не действует — убрано",
        "Часть вариантов условия «Допуск» в архиве — убраны",
        "Условие по характеристике больше не действует — убрано",
      ],
    });
    expect(
      currentConditions([{ attributeId: "spec", optionIds: ["sn"] }], attributes).removed,
    ).toEqual(["Варианты условия «Допуск» в архиве — условие убрано"]);
    expect(currentConditions([{ attributeId: "vol", max: 5 }], attributes)).toEqual({
      kept: [{ attributeId: "vol", max: 5 }],
      removed: [],
    });
  });

  it("the refusals of the server", () => {
    expect(
      maintenanceErrorText(
        refusal(409, "MAINTENANCE_PLAN_STATE", { reason: "last_active_element" }),
      ),
    ).toMatch(/последний элемент действующего плана/);
    expect(
      maintenanceErrorText(refusal(409, "MAINTENANCE_PLAN_STATE", { reason: "items_limit" })),
    ).toMatch(/100 элементов/);
    const active = refusal(409, "MAINTENANCE_PLAN_ACTIVE_EXISTS", { existingPlanId: "p1" });
    expect(activePlanOf(active)).toBe("p1");
    expect(maintenanceErrorText(active)).toMatch(/уже есть действующий план/);
    const notReady = refusal(409, "MAINTENANCE_PLAN_NOT_READY", {
      empty: false,
      items: [{ itemId: "i1", reasons: ["not_confirmed", "no_rule"] }],
    });
    expect(notReadyLines(notReady, () => "Тормозная жидкость")).toEqual([
      "«Тормозная жидкость»: не подтверждено, нет правила подбора",
    ]);
    expect(
      notReadyLines(
        refusal(409, "MAINTENANCE_PLAN_NOT_READY", { empty: true, items: [] }),
        () => "",
      ),
    ).toEqual(["В плане нет ни одного элемента"]);
    expect(
      maintenanceErrorText(refusal(400, "MAINTENANCE_TARGET_INVALID", { reason: "option" })),
    ).toBe("Такого варианта у характеристики нет");
    expect(maintenanceErrorText(refusal(409, "MAINTENANCE_DRAFT_IN_PROGRESS"))).toMatch(
      /уже составляет/,
    );
    expect(maintenanceErrorText(refusal(503, "SERVICE_UNAVAILABLE"))).toMatch(/не смог/);
  });
});
