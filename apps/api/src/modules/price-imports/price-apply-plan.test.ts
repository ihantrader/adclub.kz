import { describe, expect, it } from "vitest";
import {
  planNumbers,
  planRows,
  sendsRequest,
  type PlanFacts,
  type PlanOffer,
  type PlanRow,
} from "./price-apply-plan";
import type { MatchItem } from "./price-match-items";

const item = (id: string, extra: Partial<MatchItem> = {}): MatchItem => ({
  id,
  itemType: "part",
  available: true,
  brandId: null,
  article: null,
  articleNorm: null,
  name: id,
  brandSpellings: [],
  categoryName: "",
  parentName: "",
  ...extra,
});

const offer = (extra: Partial<PlanOffer> = {}): PlanOffer => ({
  id: "offer",
  status: "active",
  price: 10_000,
  availability: "in_stock",
  leadDays: 0,
  pickup: true,
  delivery: false,
  warrantyMonths: null,
  warrantyText: null,
  supplierSku: null,
  supplierRawName: null,
  withdrawnReason: null,
  ...extra,
});

const row = (rowNo: number, extra: Partial<PlanRow> = {}): PlanRow => ({
  rowNo,
  parsed: {
    article: `A-${String(rowNo)}`,
    articleNorm: `A${String(rowNo)}`,
    brand: null,
    name: "Деталь",
    price: 10_500,
    availability: null,
    quantity: null,
    leadDays: null,
  },
  group: "confident",
  source: "exact_article",
  itemId: "a",
  decision: null,
  decisionItemId: null,
  priceConfirmed: false,
  sendRequest: null,
  keyKind: "article",
  key: `A${String(rowNo)}`,
  ...extra,
});

function facts(extra: Partial<PlanFacts> = {}): PlanFacts {
  return {
    supplierType: "goods",
    items: new Map([
      ["a", item("a")],
      ["b", item("b")],
      ["gone", item("gone", { available: false })],
      ["service", item("service", { itemType: "service" })],
    ]),
    offers: new Map(),
    limits: { priceMin: 100, priceMax: 10_000_000, leadDaysMax: 90 },
    sharpPercent: 30,
    pointHasAddress: true,
    deliveryByDefault: false,
    openRequests: new Set(),
    rejectedRequests: new Set(),
    ...extra,
  };
}

describe("the plan of a reviewed price list", () => {
  it("creates an offer: pickup at a point with an address, delivery by the company's default", () => {
    const [plan] = planRows([row(2)], facts({ deliveryByDefault: true }));
    expect(plan!.action).toMatchObject({
      kind: "create",
      itemId: "a",
      price: 10_500,
      terms: { availability: "in_stock", leadDays: 0, pickup: true, delivery: true },
    });
    expect(plan!.remember).toEqual({ decision: "item", itemId: "a", by: "auto" });
  });

  it("refuses a new offer the rules of an offer refuse, by the very check of the cabinet", () => {
    const onOrder = row(2, { parsed: { ...row(2).parsed, availability: "on_order" } });
    expect(planRows([onOrder], facts())[0]!.action).toEqual({
      kind: "not_applied",
      reason: "on_order_needs_lead_days",
      itemId: "a",
    });
    expect(planRows([row(2)], facts({ pointHasAddress: false }))[0]!.action).toMatchObject({
      kind: "not_applied",
      reason: "no_fulfillment",
    });
    expect(
      planRows([row(2)], facts({ limits: { priceMin: 100, priceMax: 5_000, leadDaysMax: 90 } }))[0]!
        .action,
    ).toMatchObject({ kind: "not_applied", reason: "price_out_of_range" });
  });

  it("updates an offer and keeps what the file doesn't say", () => {
    const offers = new Map([["a", offer({ availability: "on_order", leadDays: 4 })]]);
    const [plan] = planRows([row(2)], facts({ offers }));
    expect(plan!.action).toMatchObject({
      kind: "update",
      change: { price: 10_500, availability: "on_order", leadDays: 4, supplierSku: "A-2" },
      returned: false,
      withdrawn: false,
    });
  });

  it("holds a sharp change of the price until it is confirmed", () => {
    const offers = new Map([["a", offer()]]);
    const sharp = row(2, { parsed: { ...row(2).parsed, price: 20_000 } });
    expect(planRows([sharp], facts({ offers }))[0]!.action).toMatchObject({
      kind: "not_applied",
      reason: "price_confirmation_required",
    });
    expect(
      planRows([{ ...sharp, priceConfirmed: true }], facts({ offers }))[0]!.action,
    ).toMatchObject({ kind: "update" });
  });

  it("withdraws by «нет в наличии» and brings a withdrawn offer back", () => {
    const out = row(2, { parsed: { ...row(2).parsed, availability: "out_of_stock" } });
    expect(planRows([out], facts({ offers: new Map([["a", offer()]]) }))[0]!.action).toMatchObject({
      kind: "update",
      withdrawn: true,
      change: { status: "withdrawn", withdrawnReason: "out_of_stock_in_import" },
    });
    expect(planRows([out], facts())[0]!.action).toMatchObject({
      kind: "not_applied",
      reason: "out_of_stock",
    });
    const back = planRows(
      [row(2)],
      facts({
        offers: new Map([["a", offer({ status: "withdrawn", withdrawnReason: "manual" })]]),
      }),
    )[0]!.action;
    expect(back).toMatchObject({ kind: "update", returned: true, change: { status: "active" } });
  });

  it("applies one row per item and only available goods", () => {
    const plans = planRows(
      [row(2), row(3), row(4, { itemId: "gone" }), row(5, { itemId: "service" })],
      facts(),
    );
    expect(plans.map((plan) => plan.action.kind === "not_applied" && plan.action.reason)).toEqual([
      false,
      "duplicate_item",
      "item_unavailable",
      "service_item",
    ]);
  });

  it("applies AI's match only after «Верно», and «Нужно проверить» left alone not at all", () => {
    const unchecked = row(2, { group: "review", source: "ai", itemId: "a" });
    expect(planRows([unchecked], facts())[0]!.action).toEqual({ kind: "skipped", unchecked: true });
    const accepted = { ...unchecked, decision: "accept" as const, decisionItemId: "b" };
    const [plan] = planRows([accepted], facts());
    expect(plan!.action).toMatchObject({ kind: "create", itemId: "b" });
    expect(plan!.remember).toEqual({ decision: "item", itemId: "b", by: "supplier" });
    expect(planRows([{ ...unchecked, decision: "skip" }], facts())[0]!.remember).toEqual({
      decision: "skip",
    });
  });

  it("sends a row not found once, remembers it, and not again after a refusal or «Не отправлять»", () => {
    const notFound = row(2, { group: "not_found", source: "ai", itemId: null });
    const [first] = planRows([notFound], facts());
    expect(first).toMatchObject({
      action: { kind: "request", created: true },
      remember: { decision: "absent" },
    });
    expect(
      planRows([notFound], facts({ openRequests: new Set(["article:A2"]) }))[0]!.action,
    ).toEqual({
      kind: "request",
      created: false,
    });
    expect(
      planRows([notFound], facts({ rejectedRequests: new Set(["article:A2"]) }))[0]!.action,
    ).toEqual({ kind: "skipped", unchecked: false });
    expect(planRows([{ ...notFound, sendRequest: false }], facts())[0]).toMatchObject({
      action: { kind: "skipped" },
      remember: { decision: "skip" },
    });
    expect(
      sendsRequest({ sendRequest: null, source: "remembered_skip", decision: null }, false),
    ).toBe(false);
  });

  it("counts the button's numbers from the very plan", () => {
    const offers = new Map([["a", offer()]]);
    const plans = planRows(
      [
        row(2),
        row(3, { itemId: "b", parsed: { ...row(3).parsed, availability: "out_of_stock" } }),
        row(4, { group: "review", source: "ai", itemId: "b" }),
        row(5, { group: "not_found", source: null, itemId: null }),
      ],
      facts({ offers: new Map([...offers, ["b", offer({ id: "offer-b" })]]) }),
    );
    expect(planNumbers(plans)).toEqual({
      update: 1,
      create: 0,
      withdraw: 1,
      request: 1,
      unchecked: 1,
      priceConfirmationRequired: 0,
    });
  });
});
