import { auditActions, type AuditActor } from "@adclub/contracts";
import { describe, expect, it } from "vitest";
import {
  actionText,
  actorText,
  almatyDayStart,
  changeLines,
  hiddenFieldsOf,
  entityLink,
  knownActions,
} from "./audit-words";

const actor = (overrides: Partial<AuditActor>): AuditActor => ({
  role: "admin",
  accountId: null,
  phoneMasked: null,
  name: null,
  adminId: null,
  supplierId: null,
  supplierMemberId: null,
  ...overrides,
});

describe("the words of the journal", () => {
  it("names every action the contract knows in Russian, and an unknown one as it is", () => {
    for (const action of Object.values(auditActions)) {
      expect(knownActions, action).toContain(action);
      expect(actionText(action)).not.toBe(action);
    }
    expect(actionText("setting.changed")).toBe("Изменена настройка");
    expect(actionText("something.new")).toBe("something.new");
  });

  it("names who acted by name and the partly hidden number, never more", () => {
    expect(actorText(actor({ name: "Айгерим", phoneMasked: "+7***4567" }))).toBe(
      "Айгерим · +7***4567",
    );
    expect(actorText(actor({ role: "user", phoneMasked: "+7***1212" }))).toBe("+7***1212");
    expect(actorText(actor({ role: "operator" }))).toBe("Оператор сервера");
    expect(actorText(actor({ role: "system" }))).toBe("Система");
    expect(actorText(actor({ role: "supplier" }))).toBe("Сотрудник поставщика");
  });

  it("shows «было → стало» field by field, only what changed", () => {
    expect(
      changeLines({ value: 2, isDefault: true }, { value: 5, isDefault: false, version: 1 }),
    ).toEqual([
      { field: "Значение", before: "2", after: "5" },
      { field: "По умолчанию", before: "да", after: "нет" },
      { field: "Версия", before: "—", after: "1" },
    ]);
    expect(changeLines(null, null)).toEqual([]);
    expect(changeLines(null, { status: "closed" })).toEqual([
      { field: "Статус", before: "—", after: "closed" },
    ]);
    expect(changeLines(3, 4)).toEqual([{ field: null, before: "3", after: "4" }]);
  });

  it("doesn't show the market of a modification (TASK-035.C)", () => {
    const hidden = hiddenFieldsOf("vehicle_modification");
    expect(
      changeLines(null, { yearFrom: 2024, market: "kz" }, hidden).map((line) => line.field),
    ).toEqual(["yearFrom"]);
    expect(
      changeLines({ market: "kz", version: 1 }, { market: "global", version: 2 }, hidden),
    ).toEqual([{ field: "Версия", before: "1", after: "2" }]);
    expect(hiddenFieldsOf("vehicle_engine")).toEqual([]);
  });

  it("takes the period by the days of Almaty", () => {
    expect(almatyDayStart("2026-10-07")).toBe("2026-10-06T19:00:00.000Z");
    expect(almatyDayStart("2026-10-07", 1)).toBe("2026-10-07T19:00:00.000Z");
    expect(almatyDayStart("")).toBeUndefined();
  });

  it("links the objects whose section exists already", () => {
    expect(entityLink("setting", "supplier_response_hours")).toBe(
      "/settings/supplier_response_hours/history",
    );
    expect(entityLink("admin_signal", "x")).toBe("/signals");
    expect(entityLink("city", "x")).toBe("/settings/cities");
    expect(entityLink("order", "x")).toBeNull();
  });

  it("opens a level of the vehicle catalog with what lies under it, and an import (TASK-035.B)", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const generation = "00000000-0000-4000-8000-000000000002";
    expect(entityLink("vehicle_make", id)).toBe(`/vehicles/makes/${id}`);
    expect(entityLink("vehicle_model", id)).toBe(`/vehicles/models/${id}`);
    expect(entityLink("vehicle_generation", id)).toBe(`/vehicles/generations/${id}`);
    expect(entityLink("vehicle_modification", id, { after: { generationId: generation } })).toBe(
      `/vehicles/generations/${generation}?highlight=${id}`,
    );
    expect(entityLink("vehicle_modification", id, { after: { status: "archived" } })).toBeNull();
    expect(entityLink("vehicle_option", id, { after: { kind: "body", order: [] } })).toBe(
      `/vehicles/options?kind=body&highlight=${id}`,
    );
    expect(entityLink("vehicle_import", id)).toBe(`/vehicles/imports/${id}`);
    expect(entityLink("vehicle_make", "not-an-id")).toBeNull();
  });

  it("opens a catalog object: an item's card, the tree on a node, an attribute or an option", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const item = "00000000-0000-4000-8000-000000000002";
    expect(entityLink("catalog_item", id)).toBe(`/catalog/items/${id}`);
    expect(entityLink("catalog_category", id)).toBe(`/catalog?node=${id}`);
    expect(entityLink("catalog_attribute", id)).toBe(`/catalog?attribute=${id}`);
    expect(entityLink("catalog_attribute_option", id)).toBe(`/catalog?option=${id}`);
    expect(entityLink("catalog_brand", id)).toBe(`/catalog/items?brandId=${id}`);
    expect(entityLink("catalog_item_photo", id, { after: { itemId: item } })).toBe(
      `/catalog/items/${item}?tab=photos`,
    );
    expect(entityLink("item_compatibility", id, { before: null, after: { itemId: item } })).toBe(
      `/catalog/items/${item}?tab=compatibility`,
    );
    expect(entityLink("catalog_translation", item, { after: { entityType: "catalog_item" } })).toBe(
      `/catalog/items/${item}?tab=translations`,
    );
    expect(entityLink("catalog_translation", id, { after: { entityType: "category" } })).toBe(
      `/catalog?node=${id}`,
    );
    // The reorder of a kind's nodes names the kind, not a category.
    expect(entityLink("catalog_category", "goods")).toBeNull();
    expect(entityLink("catalog_item_photo", id)).toBeNull();
  });
});
