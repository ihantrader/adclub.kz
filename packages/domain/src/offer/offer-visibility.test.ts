import { describe, expect, it } from "vitest";
import { supplierVisibleOnShowcase } from "../supplier/supplier-state";
import { offerVisibility, type OfferVisibilityFacts } from "./offer-visibility";
import { scheduleFact } from "./receipt-date";

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

  it("takes the schedule fact of the receipt date: hours, days off and closed dates", () => {
    const day = (n: number, open: boolean) => ({
      day: n,
      intervals: open ? [{ from: "09:00", to: "18:00" }] : [],
    });
    const at = new Date("2026-09-22T10:00:00+05:00");
    const point = (weeklyHours: ReturnType<typeof day>[] | null, closedDates: string[] = []) => ({
      timeZone: "Asia/Almaty",
      weeklyHours,
      closedDates,
    });
    const week = [1, 2, 3, 4, 5, 6, 7];
    expect(scheduleFact(at, point(null))).toBe("hours_not_set");
    expect(scheduleFact(at, point(week.map((n) => day(n, false))))).toBe("no_working_day");
    expect(scheduleFact(at, point(week.map((n) => day(n, n === 6))))).toBe("ok");
    // Every Saturday of the horizon closed: nothing works in it.
    const saturdays = Array.from({ length: 9 }, (_, index) =>
      new Date(Date.UTC(2026, 8, 26 + index * 7)).toISOString().slice(0, 10),
    );
    expect(
      scheduleFact(
        at,
        point(
          week.map((n) => day(n, n === 6)),
          saturdays,
        ),
      ),
    ).toBe("no_working_day");
    expect(
      offerVisibility({
        ...shown,
        schedule: scheduleFact(
          at,
          point(
            week.map((n) => day(n, n === 6)),
            saturdays,
          ),
        ),
      }),
    ).toEqual({ visible: false, reasons: ["no_working_day"] });
  });
});
