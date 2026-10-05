import { ApiError } from "@adclub/api-client";
import type { OfferReceipt, SupplierOffer } from "@adclub/contracts";
import { supplierText, type SupplierTextKey } from "@adclub/i18n";
import { describe, expect, it } from "vitest";
import {
  activeOrdersWarningKey,
  changedValues,
  checkOfferForm,
  formatAmount,
  hiddenReasons,
  meaningfulLength,
  newOfferForm,
  offerFormOf,
  offerProblem,
  parseAmount,
  receiptPreview,
  rowCommit,
  rowDraftOf,
  scheduleProblem,
  typeAmount,
} from "./offer-rules";

const t = (key: SupplierTextKey, params?: Readonly<Record<string, string | number>>) =>
  supplierText("ru", key, params);

function error(code: string, details?: unknown, status = 400): ApiError {
  return new ApiError({
    code: code as ApiError["code"],
    message: code,
    status,
    retryable: false,
    details,
  });
}

const offer = {
  id: "0b9d4c1e-7a5f-4c39-9f0e-2d6b8a1c3e57",
  price: 12_500,
  availability: "in_stock",
  leadDays: 0,
  pickup: true,
  delivery: false,
  warrantyMonths: null,
  warrantyText: null,
  supplierSku: null,
  supplierName: null,
  showcase: { visible: true, reasons: [] },
} as unknown as SupplierOffer;

describe("the showcase of an offer, as the server says it", () => {
  it("names each reason in order, pointing the schedule ones to «Компания»", () => {
    const hidden = {
      showcase: { visible: false, reasons: ["supplier_paused", "hours_not_set"] },
    } as unknown as SupplierOffer;
    expect(hiddenReasons(hidden)).toEqual([
      { key: "offers.hidden.paused", toCompany: false },
      { key: "offers.hidden.hoursNotSet", toCompany: true },
    ]);
    expect(hiddenReasons(offer)).toEqual([]);
  });

  it("leaves «снято с продажи» to the tab «Снятые»", () => {
    const withdrawn = {
      showcase: { visible: false, reasons: ["offer_withdrawn", "supplier_paused"] },
    } as unknown as SupplierOffer;
    expect(hiddenReasons(withdrawn, { withWithdrawn: false }).map((reason) => reason.key)).toEqual([
      "offers.hidden.paused",
    ]);
  });

  it("finds the point's schedule problem once for the whole list (D-060)", () => {
    const noHours = {
      showcase: { visible: false, reasons: ["hours_not_set"] },
    } as unknown as SupplierOffer;
    expect(scheduleProblem([offer, noHours])).toBe("hours_not_set");
    expect(scheduleProblem([offer])).toBeNull();
  });
});

describe("a refusal of the server, next to its field", () => {
  it("names the price and term bounds of the settings in the cabinet's words", () => {
    expect(
      offerProblem(error("VALIDATION_ERROR", [{ path: "price", min: 1, max: 100_000_000 }])),
    ).toEqual({
      field: "price",
      key: "offers.error.priceRange",
      params: { min: "1", max: "100 000 000" },
    });
    expect(
      offerProblem(error("VALIDATION_ERROR", [{ path: "leadDays", min: 0, max: 90 }])),
    ).toMatchObject({ field: "leadDays", key: "offers.error.leadDaysRange", params: { max: 90 } });
    // «Под заказ» with a term of 0, refused on the availability: shown at the term.
    expect(offerProblem(error("VALIDATION_ERROR", [{ path: "availability" }]))).toEqual({
      field: "leadDays",
      key: "offers.error.onOrderNeedsDays",
    });
  });

  it("shows pickup without an address and contacts in the warranty at their fields", () => {
    expect(offerProblem(error("OFFER_PICKUP_NEEDS_ADDRESS", undefined, 409))).toEqual({
      field: "pickup",
      key: "offers.error.pickupNeedsAddress",
      link: { to: "company" },
    });
    expect(offerProblem(error("OFFER_WARRANTY_CONTACTS", { found: ["phone"] }, 400))).toMatchObject(
      { field: "warrantyText", key: "offers.error.warrantyContacts" },
    );
  });

  it("links an offer that already exists, and says when it is withdrawn", () => {
    const existingOfferId = "4f0c9a52-6b1e-4d8a-9c3f-2e7b5a1d0c68";
    expect(offerProblem(error("OFFER_EXISTS", { existingOfferId, status: "active" }, 409))).toEqual(
      { field: null, key: "offers.error.exists", link: { to: "offer", offerId: existingOfferId } },
    );
    expect(
      offerProblem(error("OFFER_EXISTS", { existingOfferId, status: "withdrawn" }, 409)).key,
    ).toBe("offers.error.existsWithdrawn");
  });

  it("tells a colleague's change apart, and a network failure from a refusal", () => {
    expect(offerProblem(error("OFFER_VERSION_CONFLICT", { currentVersion: 3 }, 409))).toMatchObject(
      { conflict: true },
    );
    expect(offerProblem(error("NETWORK_ERROR", undefined, 0)).key).toBe("common.saveOffline");
    expect(offerProblem(error("OFFER_ITEM_UNAVAILABLE", undefined, 409)).key).toBe(
      "offers.error.itemUnavailable",
    );
    expect(offerProblem(new Error("boom")).key).toBe("common.saveFailed");
  });
});

describe("«Клиент увидит» from the server's receipt date", () => {
  const receipt = (date: string | null, unavailable: OfferReceipt["unavailable"] = null) =>
    ({
      confirmedAt: "2026-03-13T08:00:00.000Z",
      confirmedOn: "2026-03-13",
      timeZone: "Asia/Almaty",
      leadDays: 1,
      date,
      unavailable,
    }) satisfies OfferReceipt;

  it("says «сегодня», «завтра», or the date; delivery — «до» the same date", () => {
    expect(
      receiptPreview(receipt("2026-03-14"), { pickup: true, delivery: true }, "ru", t),
    ).toEqual(["Самовывоз — завтра, 14 марта", "Доставка — до 14 марта"]);
    expect(
      receiptPreview(receipt("2026-03-13"), { pickup: true, delivery: false }, "ru", t),
    ).toEqual(["Самовывоз — сегодня, 13 марта"]);
    expect(
      receiptPreview(receipt("2026-03-17"), { pickup: true, delivery: false }, "ru", t),
    ).toEqual(["Самовывоз — 17 марта"]);
  });

  it("has no date to show when the point has no hours", () => {
    expect(
      receiptPreview(receipt(null, "hours_not_set"), { pickup: true, delivery: false }, "ru", t),
    ).toBeNull();
  });
});

describe("whole numbers in the fields", () => {
  it("reads and groups tenge as typed", () => {
    expect(parseAmount("13 000")).toBe(13_000);
    expect(parseAmount("13 000")).toBe(13_000);
    expect(parseAmount("13,5")).toBeNull();
    expect(parseAmount("")).toBeNull();
    expect(formatAmount(100_000_000)).toBe("100 000 000");
    expect(typeAmount("0012a500")).toBe("12 500");
    expect(typeAmount("")).toBe("");
  });
});

describe("editing a row in place", () => {
  it("sends only what changed, and keeps the previous values for «Отменить»", () => {
    const draft = { ...rowDraftOf(offer), price: "13 000" };
    expect(rowCommit(offer, draft)).toEqual({
      kind: "save",
      change: { price: 13_000 },
      previous: { price: 12_500 },
    });
    expect(rowCommit(offer, rowDraftOf(offer))).toEqual({ kind: "none" });
  });

  it("doesn't send «под заказ» without a term, or a price that isn't a number", () => {
    expect(rowCommit(offer, { ...rowDraftOf(offer), availability: "on_order" })).toEqual({
      kind: "invalid",
      field: "leadDays",
      key: "offers.error.onOrderNeedsDays",
    });
    expect(
      rowCommit(offer, { ...rowDraftOf(offer), availability: "on_order", leadDays: "3" }),
    ).toEqual({
      kind: "save",
      change: { availability: "on_order", leadDays: 3 },
      previous: { availability: "in_stock", leadDays: 0 },
    });
    expect(rowCommit(offer, { ...rowDraftOf(offer), price: "" })).toMatchObject({
      kind: "invalid",
      field: "price",
    });
  });

  it("warns of active orders in the right form of the noun", () => {
    expect(t(activeOrdersWarningKey("ru", 1), { n: 1 })).toBe(
      "По этому предложению 1 активная заявка — её нужно выполнить",
    );
    expect(t(activeOrdersWarningKey("ru", 3), { n: 3 })).toContain("3 активные заявки");
    expect(t(activeOrdersWarningKey("ru", 11), { n: 11 })).toContain("11 активных заявок");
  });
});

describe("the form of an offer (S-OFF-03)", () => {
  it("starts «Доставка» from the company's setting", () => {
    expect(newOfferForm(true)).toMatchObject({ pickup: true, delivery: true });
    expect(newOfferForm(false)).toMatchObject({ pickup: true, delivery: false });
  });

  it("gives the values the contract carries, or the first field that can't be sent", () => {
    const form = { ...newOfferForm(false), price: "12 500", warranty: "text" as const };
    expect(checkOfferForm(form)).toMatchObject({ ok: false, field: "warrantyText" });
    const filled = { ...form, warrantyText: "  12 месяцев   по чеку " };
    expect(checkOfferForm(filled)).toEqual({
      ok: true,
      values: {
        price: 12_500,
        availability: "in_stock",
        leadDays: 0,
        pickup: true,
        delivery: false,
        warrantyMonths: null,
        warrantyText: "12 месяцев по чеку",
        supplierSku: null,
        supplierName: null,
      },
    });
    expect(checkOfferForm({ ...filled, pickup: false })).toMatchObject({
      ok: false,
      field: "pickup",
    });
  });

  it("saves only the fields of the card that differ", () => {
    const form = { ...offerFormOf(offer), price: "13 000", delivery: true };
    const checked = checkOfferForm(form);
    expect(checked.ok && changedValues(offer, checked.values)).toEqual({
      price: 13_000,
      delivery: true,
    });
  });
});

describe("the search of an item (S-OFF-02)", () => {
  it("counts the letters and digits of a query, as the server does", () => {
    expect(meaningfulLength("04")).toBe(2);
    expect(meaningfulLength("0-4 ")).toBe(2);
    expect(meaningfulLength("044")).toBe(3);
    expect(meaningfulLength("Мас")).toBe(3);
  });
});
