import { ApiError } from "@adclub/api-client";
import type { OfferItem, SupplierCatalogRequest } from "@adclub/contracts";
import { describe, expect, it } from "vitest";
import { createTranslate } from "../translate";
import {
  addedAction,
  conditionsText,
  formFromQuery,
  requestBody,
  requestRefusal,
  requestSource,
  requestTitle,
  statusText,
  statusTone,
} from "./moderation-rules";

const t = createTranslate("ru", null);
const A = "0b6f1c2a-1111-4c2a-9a1b-123456789abc";

const REQUEST: SupplierCatalogRequest = {
  id: A,
  status: "new",
  data: {
    article: "GDB3534",
    brand: "TRW",
    name: "Колодки передние",
    price: 9800,
    availability: "in_stock",
    leadDays: null,
  },
  importId: A,
  rowNo: 214,
  item: null,
  rejectReason: null,
  createdAt: "2026-10-13T09:00:00.000Z",
  decidedAt: null,
  source: "price_import",
  category: null,
  comment: null,
  isNew: false,
  offer: null,
};

describe("«Модерация» (S-MOD-01, TASK-048)", () => {
  it("says the status of a decision as SCREENS do", () => {
    expect(statusText("new", null, t)).toBe("На рассмотрении");
    expect(statusText("pending", null, t)).toBe("На рассмотрении");
    expect(statusText("approved", null, t)).toBe("Добавлено");
    expect(statusText("rejected", "Нет такой позиции у производителя", t)).toBe(
      "Отклонено: Нет такой позиции у производителя",
    );
    expect(statusTone("rejected")).toBe("danger");
  });

  it("tells where a request came from and what it said", () => {
    expect(requestSource(REQUEST, t)).toBe("Из прайса · строка 214");
    expect(requestSource({ ...REQUEST, source: "manual", rowNo: null, importId: null }, t)).toBe(
      "Вручную",
    );
    expect(requestTitle(REQUEST)).toEqual({ name: "Колодки передние", line: "TRW · GDB3534" });
  });

  it("offers «Выставить» for an added item the company has no offer on, and the offer otherwise", () => {
    const item = { id: A } as OfferItem;
    expect(addedAction(REQUEST)).toBeNull();
    expect(addedAction({ ...REQUEST, status: "approved", item })).toBe("put");
    expect(
      addedAction({ ...REQUEST, status: "approved", item, offer: { id: A, status: "active" } }),
    ).toBe("open");
  });

  it("names the cars of a compatibility proposal", () => {
    expect(
      conditionsText({
        make: "Geely",
        model: "Atlas",
        generation: "II",
        body: null,
        engine: "JLH-4G20TDB",
        transmission: null,
        drive: null,
        years: "2023–…",
      }),
    ).toBe("Geely Atlas II · JLH-4G20TDB · 2023–…");
  });
});

describe("the request for an item (S-OFF-05)", () => {
  it("starts from what was searched: an article-like query is the article", () => {
    expect(formFromQuery("04465 0k090").name).toBe("04465 0k090");
    expect(formFromQuery("GDB3534")).toMatchObject({ article: "GDB3534", name: "" });
    expect(formFromQuery("  ")).toMatchObject({ article: "", name: "" });
  });

  it("sends only what was filled, and nothing without a name", () => {
    expect(
      requestBody({
        name: " Фильтр салона ",
        brand: "",
        article: "",
        categoryId: null,
        comment: "",
      }),
    ).toEqual({ name: "Фильтр салона" });
    expect(
      requestBody({
        name: "Фильтр салона",
        brand: "Mann",
        article: "CUK 2939",
        categoryId: A,
        comment: "угольный",
      }),
    ).toEqual({
      name: "Фильтр салона",
      brand: "Mann",
      article: "CUK 2939",
      categoryId: A,
      comment: "угольный",
    });
    expect(
      requestBody({ name: "Ф", brand: "", article: "", categoryId: null, comment: "" }),
    ).toBeNull();
  });

  it("says why a request was refused", () => {
    const exists = new ApiError({
      code: "CATALOG_REQUEST_EXISTS",
      message: "exists",
      status: 409,
      retryable: false,
      details: { requestId: A },
    });
    expect(requestRefusal(exists, t)).toEqual({
      text: "Такой запрос уже отправлен — он на рассмотрении",
      existing: A,
    });
    const limited = new ApiError({
      code: "RATE_LIMITED",
      message: "limited",
      status: 429,
      retryable: true,
      details: { limit: "catalog_requests_per_supplier", retryAfterSeconds: 600 },
    });
    expect(requestRefusal(limited, t).text).toBe("Слишком много запросов. Попробуйте через 10 мин");
  });
});
