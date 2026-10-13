import { ApiError } from "@adclub/api-client";
import type { AdminCatalogRequest } from "@adclub/contracts";
import { describe, expect, it } from "vitest";
import { catalogRequestPath, itemFromRequestPath, locationOf, menuOf } from "../router";
import {
  itemFormFromRequest,
  requestErrorText,
  requestSourceText,
  requestTermsText,
  requestTitle,
} from "./request-words";

const A = "0b6f1c2a-1111-4c2a-9a1b-123456789abc";

const request: AdminCatalogRequest = {
  id: A,
  status: "new",
  version: 1,
  supplier: { id: A, name: "Автомаркет" },
  createdBy: { memberId: A, name: "Ерлан" },
  data: {
    article: "04465-0K090",
    brand: "Джили",
    name: "Колодки тормозные передние",
    price: 12_500,
    availability: "on_order",
    leadDays: 3,
  },
  brand: { id: A, name: "Geely" },
  import: { id: A, fileName: "1c-export.xlsx", rowNo: 214, createdAt: "2026-10-10T09:05:00.000Z" },
  item: null,
  rejectReason: null,
  decidedBy: null,
  decidedAt: null,
  createdAt: "2026-10-10T09:06:00.000Z",
  source: "price_import",
  category: null,
  comment: null,
};

describe("a request to add an item", () => {
  it("names the row and its terms", () => {
    expect(requestTitle(request.data)).toBe("04465-0K090 · Джили · Колодки тормозные передние");
    expect(requestTitle({ ...request.data, article: null, brand: null, name: null })).toBe(
      "Строка без данных",
    );
    expect(requestTermsText(request.data)).toBe("12 500 ₸ · под заказ · срок 3 р. дн.");
    expect(requestSourceText(request)).toMatch(/^прайс 1c-export\.xlsx, строка 214, /);
  });

  it("fills the form of a new item from the row, the brand by its spelling in the catalog", () => {
    expect(itemFormFromRequest(request)).toEqual({
      type: "part",
      brand: { id: A, name: "Geely", isOem: false, status: "active" },
      article: "04465-0K090",
      ru: "Колодки тормозные передние",
    });
    expect(
      itemFormFromRequest({ ...request, brand: null, data: { ...request.data, article: null } }),
    ).toMatchObject({ type: "generic", brand: null, article: "" });
  });

  it("marks a request sent by hand and takes the subcategory the supplier suggested (TASK-048)", () => {
    const manual: AdminCatalogRequest = {
      ...request,
      source: "manual",
      import: null,
      category: { id: A, name: "Тормозные колодки" },
      comment: "Есть в наличии 10 комплектов",
    };
    expect(requestSourceText(manual)).toBe("вручную, из кабинета поставщика");
    expect(itemFormFromRequest(manual)).toMatchObject({ categoryId: A });
    expect(itemFormFromRequest(request)).not.toHaveProperty("categoryId");
  });

  it("says who decided a request meanwhile", () => {
    const decided = new ApiError({
      status: 409,
      code: "CATALOG_REQUEST_VERSION_CONFLICT",
      message: "decided",
      details: {
        status: "rejected",
        version: 2,
        decidedBy: { adminId: A, name: "Айгерим" },
        decidedAt: "2026-10-10T09:10:00.000Z",
      },
      retryable: false,
    });
    expect(requestErrorText(decided)).toMatch(/^Запрос уже рассмотрел Айгерим, .*: отклонено\./);
  });

  it("has its addresses in the catalog", () => {
    expect(locationOf(catalogRequestPath(A))).toMatchObject({ route: "catalogRequest", id: A });
    expect(locationOf("/catalog/requests").route).toBe("catalogRequests");
    expect(itemFromRequestPath(A)).toBe(`/catalog/items/new?requestId=${A}`);
    expect(menuOf("catalogRequest")).toBe("catalog");
    expect(menuOf("catalogRequests")).toBe("catalog");
  });
});
