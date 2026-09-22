import { describe, expect, it } from "vitest";
import { supplierVisibleOnShowcase } from "../supplier/supplier-state";
import { offerVisibility, scheduleFact, type OfferVisibilityFacts } from "./offer-visibility";

const shown: OfferVisibilityFacts = {
  offerStatus: "active",
  supplierPauseReason: null,
  supplierBlocked: false,
  itemStatus: "active",
  categoryVisible: true,
  hasCity: true,
  schedule: "ok",
};

describe("an offer on the showcase", () => {
  it("is shown when everything is in order", () => {
    expect(offerVisibility(shown)).toEqual({ visible: true, reasons: [] });
  });

  it.each([
    [{ offerStatus: "withdrawn" as const }, ["offer_withdrawn"]],
    [{ offerStatus: "suspended" as const }, ["offer_suspended"]],
    [{ supplierPauseReason: "admin" as const }, ["supplier_paused"]],
    [{ supplierPauseReason: "billing" as const }, ["supplier_paused"]],
    [{ supplierBlocked: true }, ["supplier_blocked"]],
    [{ itemStatus: "archived" }, ["item_unavailable"]],
    [{ itemStatus: "draft" }, ["item_unavailable"]],
    [{ categoryVisible: false }, ["category_hidden"]],
    [{ hasCity: false }, ["no_city"]],
    [{ schedule: "hours_not_set" as const }, ["hours_not_set"]],
    [{ schedule: "no_working_day" as const }, ["no_working_day"]],
  ])("is hidden by %o", (change, reasons) => {
    expect(offerVisibility({ ...shown, ...change })).toEqual({ visible: false, reasons });
  });

  it("names every reason at once, in a fixed order", () => {
    expect(
      offerVisibility({
        offerStatus: "withdrawn",
        supplierPauseReason: "billing",
        supplierBlocked: true,
        itemStatus: "archived",
        categoryVisible: false,
        hasCity: false,
        schedule: "hours_not_set",
      }).reasons,
    ).toEqual([
      "offer_withdrawn",
      "supplier_blocked",
      "supplier_paused",
      "item_unavailable",
      "category_hidden",
      "no_city",
      "hours_not_set",
    ]);
  });

  it("agrees with the supplier's showcase sign in every state", () => {
    for (const pauseReason of [null, "admin", "billing"] as const) {
      for (const blocked of [false, true]) {
        expect(
          offerVisibility({ ...shown, supplierPauseReason: pauseReason, supplierBlocked: blocked })
            .visible,
        ).toBe(supplierVisibleOnShowcase({ pauseReason, blocked }));
      }
    }
  });

  it("takes the schedule fact from the point's weekly hours", () => {
    const day = (n: number, open: boolean) => ({
      day: n,
      intervals: open ? [{ from: "09:00", to: "18:00" }] : [],
    });
    expect(scheduleFact(null)).toBe("hours_not_set");
    expect(scheduleFact([1, 2, 3, 4, 5, 6, 7].map((n) => day(n, false)))).toBe("no_working_day");
    expect(scheduleFact([1, 2, 3, 4, 5, 6, 7].map((n) => day(n, n === 6)))).toBe("ok");
  });
});
