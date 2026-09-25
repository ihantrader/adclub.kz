import { describe, expect, it } from "vitest";
import type { OfferHiddenReason } from "../offer/offer-visibility";
import { orderRepeatDecision, type OrderRepeatFacts } from "./order-repeat";

function facts(over: Partial<OrderRepeatFacts> = {}): OrderRepeatFacts {
  return {
    orderKind: "stock",
    hasClubAccess: true,
    offerVisible: true,
    hiddenReasons: [],
    ...over,
  };
}

describe("orderRepeatDecision", () => {
  it("repeats from the same offer while it is on the showcase", () => {
    expect(orderRepeatDecision(facts())).toEqual({ kind: "offer" });
  });

  it("sends to the catalog when the offer was withdrawn", () => {
    expect(
      orderRepeatDecision(facts({ offerVisible: false, hiddenReasons: ["offer_withdrawn"] })),
    ).toEqual({ kind: "catalog", reason: "offer_withdrawn" });
  });

  it("sends to the catalog when the supplier can't take orders now", () => {
    const reasons: OfferHiddenReason[] = [
      "offer_suspended",
      "supplier_paused",
      "supplier_blocked",
      "no_city",
      "hours_not_set",
      "no_working_day",
    ];
    for (const reason of reasons) {
      expect(
        orderRepeatDecision(facts({ offerVisible: false, hiddenReasons: [reason] })),
        reason,
      ).toEqual({ kind: "catalog", reason: "supplier_unavailable" });
    }
  });

  it("has nothing to repeat once the item left the catalog", () => {
    for (const reason of ["item_unavailable", "category_hidden"] as const) {
      expect(
        orderRepeatDecision(facts({ offerVisible: false, hiddenReasons: [reason] })),
        reason,
      ).toEqual({ kind: "unavailable", reason: "item_unavailable" });
    }
    // The item outweighs the offer: an archived item with a withdrawn offer
    // has no card to open either.
    expect(
      orderRepeatDecision(
        facts({ offerVisible: false, hiddenReasons: ["offer_withdrawn", "item_unavailable"] }),
      ),
    ).toEqual({ kind: "unavailable", reason: "item_unavailable" });
  });

  it("asks for club access before anything else", () => {
    expect(
      orderRepeatDecision(
        facts({ hasClubAccess: false, offerVisible: false, hiddenReasons: ["offer_withdrawn"] }),
      ),
    ).toEqual({ kind: "unavailable", reason: "club_access_required" });
  });

  it("refuses a kind the server can't create yet (services, under order — EPIC-13)", () => {
    expect(orderRepeatDecision(facts({ orderKind: "service" }))).toEqual({
      kind: "unavailable",
      reason: "kind_not_supported",
    });
    expect(orderRepeatDecision(facts({ orderKind: "on_order" }))).toEqual({
      kind: "unavailable",
      reason: "kind_not_supported",
    });
  });
});
