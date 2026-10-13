import { describe, expect, it } from "vitest";
import { findPriceHeader, recognizePriceColumns } from "./price-columns";
import {
  PRICE_EXPORT_COLUMNS,
  priceExportHeader,
  priceExportRoles,
  priceExportRow,
  type PriceExportOffer,
} from "./price-export";
import { isItemIdText, readPriceRow } from "./price-values";

const ITEM = "5f0c2a4e-1d1b-4c55-9a3e-0f7d2a1b9c11";

const OFFER: PriceExportOffer = {
  itemId: ITEM,
  supplierSku: null,
  catalogArticle: "04465-0K090",
  brand: "Geely",
  supplierName: null,
  catalogName: "Колодки тормозные передние Geely Atlas",
  price: 12_500,
  availability: "in_stock",
  leadDays: 0,
  status: "active",
  pickup: true,
  delivery: false,
  warrantyMonths: 12,
  warrantyText: null,
};

const LIMITS = { priceMin: 1, priceMax: 10_000_000, leadDaysMax: 90 };

describe("the cabinet's export of its own price list (TASK-048)", () => {
  it("has the hidden item column first and the columns of ARCHITECTURE 12.4", () => {
    expect(PRICE_EXPORT_COLUMNS).toEqual([
      "item_id",
      "article",
      "brand",
      "name",
      "price",
      "availability",
      "lead_days",
      "pickup",
      "delivery",
      "warranty",
    ]);
    expect(priceExportHeader("ru")[0]).toBe("item_id");
    expect(priceExportHeader("kk")).toHaveLength(PRICE_EXPORT_COLUMNS.length);
  });

  it("reads every exported row back to the same values in every language", () => {
    const offers: PriceExportOffer[] = [
      OFFER,
      {
        ...OFFER,
        availability: "on_order",
        leadDays: 3,
        supplierSku: "ATL-PADS",
        supplierName: "Колодки Атлас",
      },
      { ...OFFER, status: "withdrawn", warrantyMonths: null, warrantyText: "по чеку" },
    ];
    for (const lang of ["ru", "kk", "en"] as const) {
      for (const offer of offers) {
        const { parsed, errors } = readPriceRow(
          priceExportRow(offer, lang),
          priceExportRoles(),
          LIMITS,
        );
        expect(errors, lang).toEqual([]);
        expect(parsed.itemId).toBe(ITEM);
        expect(parsed.price).toBe(offer.price);
        expect(parsed.leadDays).toBe(offer.leadDays);
        expect(parsed.article).toBe(offer.supplierSku ?? offer.catalogArticle);
        expect(parsed.name).toBe(offer.supplierName ?? offer.catalogName);
        expect(parsed.availability).toBe(
          offer.status === "withdrawn" ? "out_of_stock" : offer.availability,
        );
      }
    }
  });

  it("is recognised by its header: the item column by its name, the rest by the dictionary", () => {
    const header = priceExportHeader("ru");
    expect(findPriceHeader([header, priceExportRow(OFFER, "ru")])).toBe(0);
    const roles = recognizePriceColumns(header, [priceExportRow(OFFER, "ru")], header.length);
    expect(roles.map((guess) => guess.role).slice(0, 7)).toEqual([
      "item_id",
      "article",
      "brand",
      "name",
      "price",
      "availability",
      "lead_days",
    ]);
  });

  it("leaves pickup, delivery and the warranty to the offer itself", () => {
    expect(priceExportRoles().slice(7)).toEqual(["ignore", "ignore", "ignore"]);
    expect(priceExportRow(OFFER, "ru").slice(7)).toEqual(["Да", "Нет", "12 мес."]);
  });

  it("reads a file without the item column as before", () => {
    const { parsed } = readPriceRow(["A1", "Колодки", 1000], ["article", "name", "price"], LIMITS);
    expect(parsed).not.toHaveProperty("itemId");
  });

  it("tells an id from anything else typed into the item column", () => {
    expect(isItemIdText(ITEM)).toBe(true);
    expect(isItemIdText("123")).toBe(false);
    expect(isItemIdText(`${ITEM}x`)).toBe(false);
  });
});
