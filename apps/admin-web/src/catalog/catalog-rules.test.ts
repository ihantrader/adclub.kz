import {
  adminHomeCatalogFilters,
  type AdminAttribute,
  type CatalogValueRejection,
  type CategoryFillRow,
} from "@adclub/contracts";
import { describe, expect, it } from "vitest";
import { locationOf, menuOf } from "../router";
import {
  catalogErrorText,
  conflictText,
  errorField,
  offerPriceText,
  offerTermsText,
} from "./catalog-words";
import { suggestCode } from "./codes";
import { cellErrors, cellKey, fillCells, rowValue, withEdit } from "./fill-state";
import { filtered, itemFiltersOf, itemsLink, listQueryOf } from "./item-filters";
import { attributeOrderBody, categoryOrderBody, moveInOrder, optionOrderBody } from "./order";
import { numberHint, parseValue, valueInput, valueText } from "./values";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";

function attribute(overrides: Partial<AdminAttribute>): AdminAttribute {
  return {
    id: A,
    categoryId: B,
    code: "x",
    valueType: "text",
    names: {
      ru: { text: "Материал", origin: "source", isManuallyEdited: false },
      kk: null,
      en: null,
    },
    unit: null,
    number: null,
    isFilterable: false,
    isRequiredForComplete: false,
    sort: 0,
    status: "active",
    version: 1,
    archivedAt: null,
    updatedAt: "2026-10-07T00:00:00.000Z",
    options: [],
    ...overrides,
  };
}

describe("the order of siblings (I151)", () => {
  it("always sends the order it was made from as expectedOrder", () => {
    const siblings = [{ id: A }, { id: B }, { id: C }];
    expect(categoryOrderBody(null, "goods", siblings, 1, -1)).toEqual({
      parentId: null,
      kind: "goods",
      categoryIds: [B, A, C],
      expectedOrder: [A, B, C],
    });
    expect(categoryOrderBody(A, "services", siblings, 0, 1)).toMatchObject({
      parentId: A,
      kind: "services",
      expectedOrder: [A, B, C],
    });
    expect(attributeOrderBody(siblings, 2, -1)).toEqual({
      attributeIds: [A, C, B],
      expectedOrder: [A, B, C],
    });
    expect(optionOrderBody(siblings, 0, 1)).toEqual({
      optionIds: [B, A, C],
      expectedOrder: [A, B, C],
    });
  });

  it("does nothing at the edges", () => {
    expect(moveInOrder([A, B], 0, -1)).toBeNull();
    expect(moveInOrder([A, B], 1, 1)).toBeNull();
    expect(attributeOrderBody([{ id: A }], 0, 1)).toBeNull();
  });
});

describe("values by type", () => {
  it("reads numbers with the unit, lists by option, yes-no in words", () => {
    const thickness = attribute({
      valueType: "number",
      unit: { ru: { text: "мм", origin: "source", isManuallyEdited: false }, kk: null, en: null },
      number: { integer: false, min: 0, max: 50 },
    });
    expect(valueText(thickness, 17.5)).toBe("17,5 мм");
    expect(valueText(thickness, null)).toBe("—");
    const material = attribute({
      valueType: "enum",
      options: [
        {
          id: C,
          attributeId: A,
          code: "ceramic",
          names: {
            ru: { text: "Керамика", origin: "source", isManuallyEdited: false },
            kk: null,
            en: null,
          },
          sort: 0,
          status: "active",
          version: 1,
          archivedAt: null,
          updatedAt: "2026-10-07T00:00:00.000Z",
        },
      ],
    });
    expect(valueText(material, C)).toBe("Керамика");
    expect(valueText(attribute({ valueType: "bool" }), true)).toBe("Да");
    expect(valueInput(17.5)).toBe("17,5");
  });

  it("parses what was typed, with a comma and the bounds as a hint", () => {
    const whole = attribute({ valueType: "number", number: { integer: true, min: 1, max: 10 } });
    expect(parseValue(whole, " 4 ")).toEqual({ value: 4 });
    expect(parseValue(whole, "")).toEqual({ value: null });
    expect(parseValue(whole, "4,5")).toEqual({ error: "Нужно целое число" });
    expect(parseValue(whole, "11")).toEqual({ error: "Не больше 10" });
    expect(parseValue(whole, "abc")).toEqual({ error: "Введите число" });
    const fraction = attribute({
      valueType: "number",
      number: { integer: false, min: null, max: null },
    });
    expect(parseValue(fraction, "1 234,5")).toEqual({ value: 1234.5 });
    expect(parseValue(attribute({ valueType: "bool" }), "false")).toEqual({ value: false });
    expect(parseValue(attribute({ valueType: "text" }), "  керамика ")).toEqual({
      value: "керамика",
    });
    expect(numberHint(whole)).toBe("целое, от 1, до 10");
  });
});

describe("the filters of the items list", () => {
  it("opens every home card with exactly the filters the server counted", () => {
    for (const filters of Object.values(adminHomeCatalogFilters)) {
      const link = itemsLink(filters);
      const [path, search] = link.split("?");
      expect(locationOf(path!, `?${search}`).route).toBe("catalogItems");
      const read = itemFiltersOf(new URLSearchParams(search));
      expect(read).toEqual(filters);
      expect(listQueryOf(read, { limit: 50 })).toEqual({ ...filters, limit: 50 });
    }
  });

  it("leaves out malformed values", () => {
    const read = itemFiltersOf(
      new URLSearchParams(
        "categoryId=nope&status=gone&hasOffers=1&q=%20&type=part&withoutPhoto=true",
      ),
    );
    expect(read).toEqual({ type: "part", withoutPhoto: "true" });
    expect(filtered({})).toBe(false);
    expect(filtered(read)).toBe(true);
  });

  it("belongs to the catalog in the menu, with the card and the fill", () => {
    expect(locationOf(`/catalog/items/${A}`)).toMatchObject({ route: "catalogItem", id: A });
    expect(locationOf(`/catalog/fill/${B}`)).toMatchObject({ route: "catalogFill", id: B });
    expect(locationOf("/catalog/items/new").route).toBe("catalogItemNew");
    expect(locationOf("/catalog/items/not-an-id").route).toBeNull();
    for (const route of [
      "catalogItems",
      "catalogItem",
      "catalogFill",
      "catalogProposals",
    ] as const) {
      expect(menuOf(route)).toBe("catalog");
    }
  });
});

describe("the fill table", () => {
  const row: CategoryFillRow = {
    item: { id: A } as CategoryFillRow["item"],
    values: [{ attributeId: B, value: null }],
  };

  it("sends what changed with the value it was read with, and forgets a cell set back", () => {
    expect(rowValue(row, B)).toBeNull();
    let edits = withEdit(new Map(), { itemId: A, attributeId: B, previous: null, value: "x" });
    expect(fillCells(edits)).toEqual([{ itemId: A, attributeId: B, previous: null, value: "x" }]);
    edits = withEdit(edits, { itemId: A, attributeId: B, previous: null, value: null });
    expect(fillCells(edits)).toEqual([]);
  });

  it("puts refusals at their cells and rebases a conflict on the value stored now", () => {
    const edits = withEdit(new Map(), { itemId: A, attributeId: B, previous: null, value: "x" });
    const sent = fillCells(edits);
    const rejections: CatalogValueRejection[] = [
      {
        index: 0,
        itemId: A,
        attributeId: B,
        reason: "conflict",
        message: "changed",
        currentValue: "y",
      },
    ];
    const errors = cellErrors(sent, rejections);
    expect(errors.get(cellKey(A, B))).toEqual({ message: "Значение уже изменили", current: "y" });
    // Made against the value stored now, the same edit is a change again.
    const rebased = withEdit(new Map(), { itemId: A, attributeId: B, previous: "y", value: "x" });
    expect(fillCells(rebased)).toEqual([{ itemId: A, attributeId: B, previous: "y", value: "x" }]);
  });
});

describe("codes of new entries", () => {
  it("suggests a snake_case code from the Russian name", () => {
    expect(suggestCode("Тормозные колодки")).toBe("tormoznye_kolodki");
    expect(suggestCode("Материал")).toBe("material");
    expect(suggestCode("5W-30", false)).toBe("5w_30");
    expect(suggestCode("5W-30")).toBe("x_5w_30");
  });
});

describe("the words of refusals", () => {
  it("names who changed the data when known", () => {
    expect(conflictText("Айгерим")).toBe(
      "Эти данные только что изменил Айгерим. Обновите страницу",
    );
    expect(conflictText(null)).toContain("другой администратор");
  });

  it("puts a taken name at its language and says the photo refusals in words", async () => {
    const { ApiError } = await import("@adclub/api-client");
    const taken = new ApiError({
      status: 409,
      code: "CATALOG_NAME_TAKEN",
      message: "taken",
      retryable: false,
      details: { lang: "kk", conflictingId: A },
    });
    expect(errorField(taken)).toBe("names.kk");
    expect(catalogErrorText(taken)).toBe("Такое казахское название уже есть у соседнего узла");
    const photo = new ApiError({
      status: 400,
      code: "CATALOG_PHOTO_INVALID",
      message: "bad",
      retryable: false,
      details: { reason: "not_an_image" },
    });
    expect(catalogErrorText(photo)).toBe("Это не изображение");
  });
});

describe("offers in words (A-SUP-03, A-CAT-05; TASK-019)", () => {
  const goods = {
    item: { type: "part" as const },
    price: 12_500,
    pricing: { mode: "single" as const, models: [] },
    availability: "on_order" as const,
    leadDays: 3,
    pickup: true,
    delivery: false,
  };

  it("says a product's price and terms, and a service's prices by model", () => {
    expect(offerPriceText(goods).replace(/\s/g, " ")).toBe("12 500 ₸");
    expect(offerTermsText(goods)).toBe("под заказ, 3 дн. · самовывоз");
    const row = (model: string, price: number, available = true) => ({
      make: { id: "m", name: "Geely" },
      model: { id: model, name: model },
      price,
      available,
    });
    const service = {
      ...goods,
      item: { type: "service" as const },
      price: 8_000,
      pricing: {
        mode: "by_model" as const,
        models: [row("Atlas", 10_000), row("Coolray", 8_000), row("Tugella", 15_000, false)],
      },
    };
    expect(offerPriceText(service).replace(/\s/g, " ")).toBe(
      "от 8 000 ₸: Geely Atlas 10 000, Geely Coolray 8 000, Geely Tugella 15 000 (в архиве)",
    );
    expect(offerTermsText(service)).toBe("услуга в точке");
  });
});
