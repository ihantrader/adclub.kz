import { ApiError } from "@adclub/api-client";
import type { SupplierOffer } from "@adclub/contracts";
import { supplierText } from "@adclub/i18n";
import { describe, expect, it } from "vitest";
import {
  changedServiceValues,
  checkServiceForm,
  newModelRow,
  newServiceForm,
  serviceFormOf,
  servicePreview,
  servicePriceLine,
  serviceProblem,
  type ModelRow,
  type ServiceForm,
} from "./service-offer-rules";

const t = (key: Parameters<typeof supplierText>[1], params?: Record<string, string | number>) =>
  supplierText("ru", key, params);

const COOLRAY = "11111111-1111-4111-8111-111111111111";
const ATLAS = "22222222-2222-4222-8222-222222222222";
const GEELY = { id: "33333333-3333-4333-8333-333333333333", label: "Geely" };

function row(modelId: string, label: string, price: string, available = true) {
  return { ...newModelRow(), make: GEELY, model: { id: modelId, label }, price, available };
}

const byModel = (rows: ModelRow[]): ServiceForm => ({
  ...newServiceForm(),
  mode: "by_model",
  rows,
});

function apiError(code: string, details: unknown, status = 400): ApiError {
  return new ApiError({
    code: code as ApiError["code"],
    message: code,
    status,
    retryable: false,
    details,
  });
}

const offer = {
  id: "44444444-4444-4444-8444-444444444444",
  price: 8_000,
  pricing: {
    mode: "by_model",
    models: [
      {
        make: { id: GEELY.id, name: "Geely" },
        model: { id: ATLAS, name: "Atlas" },
        price: 10_000,
        available: true,
      },
      {
        make: { id: GEELY.id, name: "Geely" },
        model: { id: COOLRAY, name: "Coolray" },
        price: 8_000,
        available: true,
      },
    ],
  },
  warrantyMonths: null,
  warrantyText: null,
  supplierSku: null,
  supplierName: null,
} as unknown as SupplierOffer;

describe("the form of an offer on a service (S-OFF-04)", () => {
  it("sends one price, or the table of prices by model", () => {
    expect(checkServiceForm({ ...newServiceForm(), price: "7 000" })).toMatchObject({
      ok: true,
      values: { price: 7_000 },
    });
    const check = checkServiceForm(
      byModel([row(COOLRAY, "Coolray", "8 000"), row(ATLAS, "Atlas", "10 000"), newModelRow()]),
    );
    expect(check).toMatchObject({
      ok: true,
      values: {
        modelPrices: [
          { modelId: COOLRAY, price: 8_000 },
          { modelId: ATLAS, price: 10_000 },
        ],
      },
    });
    expect(check.ok && "price" in check.values).toBe(false);
  });

  it("stops at the row to fix: no model, a model twice, a price that isn't a number", () => {
    expect(checkServiceForm({ ...newServiceForm(), price: "" })).toMatchObject({
      ok: false,
      problem: { field: "price" },
    });
    expect(checkServiceForm(byModel([newModelRow()]))).toMatchObject({
      ok: false,
      problem: { field: "rows", key: "serviceForm.error.noRows" },
    });
    expect(
      checkServiceForm(
        byModel([row(COOLRAY, "Coolray", "8 000"), row(COOLRAY, "Coolray", "9 000")]),
      ),
    ).toMatchObject({
      ok: false,
      problem: { field: { row: 1, part: "model" }, key: "serviceForm.error.duplicate" },
    });
    expect(
      checkServiceForm(byModel([{ ...newModelRow(), make: GEELY, price: "5 000" }])),
    ).toMatchObject({ ok: false, problem: { field: { row: 0, part: "model" } } });
    expect(checkServiceForm(byModel([row(COOLRAY, "Coolray", "")]))).toMatchObject({
      ok: false,
      problem: { field: { row: 0, part: "price" } },
    });
  });

  it("changes only what differs: the same table in another order sends nothing", () => {
    const form = serviceFormOf(offer);
    expect(form.mode).toBe("by_model");
    const same = checkServiceForm({ ...form, rows: [...form.rows].reverse() });
    expect(same.ok && changedServiceValues(offer, same.values)).toEqual({});
    const cheaper = checkServiceForm({
      ...form,
      rows: form.rows.map((entry) =>
        entry.model?.id === COOLRAY ? { ...entry, price: "7 500" } : entry,
      ),
    });
    expect(cheaper.ok && changedServiceValues(offer, cheaper.values)).toEqual({
      modelPrices: [
        { modelId: ATLAS, price: 10_000 },
        { modelId: COOLRAY, price: 7_500 },
      ],
    });
    const single = checkServiceForm({ ...form, mode: "single", price: "8 000" });
    // One price of the same amount is still another kind of price.
    expect(single.ok && changedServiceValues(offer, single.values)).toEqual({ price: 8_000 });
  });

  it("puts the server's refusal at the row it numbers", () => {
    const form = byModel([
      newModelRow(),
      row(COOLRAY, "Coolray", "8 000"),
      row(ATLAS, "Atlas", "1"),
    ]);
    const range = apiError("VALIDATION_ERROR", [
      { path: "modelPrices.1.price", message: "range", min: 100, max: 50_000 },
    ]);
    expect(serviceProblem(range, form)).toMatchObject({
      field: { row: 2, part: "price" },
      key: "offers.error.priceRange",
      params: { min: "100", max: "50 000" },
    });
    const twice = apiError("VALIDATION_ERROR", [
      { path: "modelPrices.0.modelId", message: "This model already has a price in the table" },
    ]);
    expect(serviceProblem(twice, form)).toMatchObject({
      field: { row: 1, part: "model" },
      key: "serviceForm.error.duplicate",
    });
    const type = apiError(
      "OFFER_NOT_APPLICABLE",
      { supplierType: "goods", itemType: "service" },
      409,
    );
    expect(serviceProblem(type, form)).toMatchObject({
      field: null,
      key: "offers.error.goodsOnly",
    });
  });

  it("says the price «от N ₸ · M моделей» and what each model's owner sees", () => {
    expect(servicePriceLine(offer, "ru", t)).toBe("от 8 000 ₸ · 2 модели");
    expect(
      servicePriceLine({ price: 5_000, pricing: { mode: "single", models: [] } }, "ru", t),
    ).toBe("5 000 ₸");
    expect(
      servicePreview(
        byModel([row(COOLRAY, "Coolray", "8 000"), row(ATLAS, "Atlas", "10 000", false)]),
        t,
      ),
    ).toEqual(["Geely Coolray — 8 000 ₸", "Geely Atlas — не увидят", "Другие модели — не увидят"]);
    expect(servicePreview({ ...newServiceForm(), price: "7 000" }, t)).toEqual([
      "7 000 ₸ — для любой модели",
    ]);
  });
});
