import { describe, expect, it } from "vitest";
import { referencesOf } from "./audit-names";

const PLAN = "11111111-1111-4111-8111-111111111111";
const MAKE = "22222222-2222-4222-8222-222222222222";
const ITEM_A = "33333333-3333-4333-8333-333333333333";
const ITEM_B = "44444444-4444-4444-8444-444444444444";

describe("referencesOf", () => {
  it("finds the ids of a field, of a list under a known field and of an object one level down", () => {
    expect(
      referencesOf({
        entityType: "maintenance_plan",
        entityId: PLAN,
        before: { itemIds: [ITEM_A, ITEM_B] },
        after: { scope: { makeId: MAKE, modelId: null }, planId: PLAN, name: "Geely" },
      }),
    ).toEqual([
      ["maintenance_plan_item", ITEM_A],
      ["maintenance_plan_item", ITEM_B],
      ["vehicle_make", MAKE],
      ["maintenance_plan", PLAN],
    ]);
  });

  it("goes no deeper than one level and ignores what is not an id", () => {
    expect(
      referencesOf({
        entityType: "x",
        entityId: PLAN,
        before: { a: { b: { makeId: MAKE } }, makeId: "not-an-id", values: [MAKE] },
        after: null,
      }),
    ).toEqual([]);
  });
});
