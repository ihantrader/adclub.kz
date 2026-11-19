import { describe, expect, it } from "vitest";
import {
  acceptedAiMatch,
  auditDraw,
  priceAuditBucket,
  priceAuditOfferVerdict,
  priceAuditReason,
  type PriceAuditRowFacts,
} from "./price-match-audit";

const accepted: PriceAuditRowFacts = {
  id: "import-1:5",
  aiProposed: true,
  decision: "accept",
  decisionItemId: "item-a",
  aiItemId: "item-a",
  aiConfidence: 0.93,
  outcome: "created",
};
const sampling = { share: 0.1, alwaysBelow: 0.9 };

describe("acceptedAiMatch", () => {
  it("takes only applied rows where the supplier accepted the item AI chose", () => {
    expect(acceptedAiMatch(accepted)).toBe(true);
    for (const outcome of ["updated", "unchanged", "returned"] as const) {
      expect(acceptedAiMatch({ ...accepted, outcome }), outcome).toBe(true);
    }
    for (const outcome of ["withdrawn", "requested", "skipped", "not_applied", null] as const) {
      expect(acceptedAiMatch({ ...accepted, outcome }), String(outcome)).toBe(false);
    }
  });

  it("leaves out «Другая позиция», another candidate, and rows AI did not propose", () => {
    expect(acceptedAiMatch({ ...accepted, decision: "other" })).toBe(false);
    expect(acceptedAiMatch({ ...accepted, decisionItemId: "item-b" })).toBe(false);
    expect(acceptedAiMatch({ ...accepted, aiProposed: false })).toBe(false);
    expect(acceptedAiMatch({ ...accepted, decision: null })).toBe(false);
    expect(acceptedAiMatch({ ...accepted, aiItemId: null })).toBe(false);
  });
});

describe("priceAuditReason", () => {
  it("always takes a row below the bound", () => {
    expect(priceAuditReason({ ...accepted, aiConfidence: 0.89 }, sampling)).toBe("below");
    expect(
      priceAuditReason({ ...accepted, aiConfidence: 0.6 }, { share: 0, alwaysBelow: 0.9 }),
    ).toBe("below");
  });

  it("takes about the share of rows at or above the bound, fixed by the row's id", () => {
    let taken = 0;
    for (let rowNo = 0; rowNo < 10_000; rowNo += 1) {
      const row = { ...accepted, id: `0f7c5b8e-4d1a-4c66-9a51-1d2e3f4a5b6c:${rowNo}` };
      const reason = priceAuditReason(row, sampling);
      expect(reason === null || reason === "share").toBe(true);
      expect(priceAuditReason(row, sampling)).toBe(reason);
      if (reason) taken += 1;
    }
    expect(taken).toBeGreaterThan(850);
    expect(taken).toBeLessThan(1150);
  });

  it("takes nothing at share 0 above the bound, and every row at share 1", () => {
    expect(priceAuditReason(accepted, { share: 0, alwaysBelow: 0.9 })).toBeNull();
    expect(priceAuditReason(accepted, { share: 1, alwaysBelow: 0 })).toBe("share");
  });

  it("never takes a row that isn't an accepted AI match", () => {
    expect(
      priceAuditReason({ ...accepted, decision: "other", aiConfidence: 0.5 }, sampling),
    ).toBeNull();
  });

  it("draws in [0, 1)", () => {
    for (const id of ["", "a", "x:1", "zzzzzzzzzzzzzzzzzzzzzzzz"]) {
      const value = auditDraw(id);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe("priceAuditOfferVerdict", () => {
  const offer = {
    status: "active" as const,
    editedByHand: false,
    activeOrders: 0,
    rowOutcome: "created" as const,
    createdByImport: true,
  };

  it("withdraws an active offer untouched by hand and without active orders", () => {
    expect(priceAuditOfferVerdict(offer)).toEqual({ withdraw: true });
  });

  it("withdraws only the offer the row made, returned, or changed after a price list made it (TASK-065.A)", () => {
    for (const rowOutcome of ["created", "returned", null] as const) {
      expect(priceAuditOfferVerdict({ ...offer, rowOutcome, createdByImport: false })).toEqual({
        withdraw: true,
      });
    }
    expect(priceAuditOfferVerdict({ ...offer, rowOutcome: "updated" })).toEqual({ withdraw: true });
    const notByRow = { withdraw: false, reason: "not_by_row" };
    expect(
      priceAuditOfferVerdict({ ...offer, rowOutcome: "updated", createdByImport: false }),
    ).toEqual(notByRow);
    expect(priceAuditOfferVerdict({ ...offer, rowOutcome: "unchanged" })).toEqual(notByRow);
    // Not the row's comes first: the supplier's own offer is not «edited» or «with orders».
    expect(priceAuditOfferVerdict({ ...offer, rowOutcome: "unchanged", activeOrders: 3 })).toEqual(
      notByRow,
    );
  });

  it("keeps the offer otherwise, and says why", () => {
    expect(priceAuditOfferVerdict(null)).toEqual({ withdraw: false, reason: "no_offer" });
    expect(priceAuditOfferVerdict({ ...offer, status: "withdrawn" })).toEqual({
      withdraw: false,
      reason: "not_active",
    });
    expect(priceAuditOfferVerdict({ ...offer, activeOrders: 2, editedByHand: true })).toEqual({
      withdraw: false,
      reason: "active_orders",
    });
    expect(priceAuditOfferVerdict({ ...offer, editedByHand: true })).toEqual({
      withdraw: false,
      reason: "edited",
    });
  });
});

describe("priceAuditBucket", () => {
  it("puts the bounds into the upper bucket", () => {
    expect(priceAuditBucket(0.5)).toBe("lt_0_7");
    expect(priceAuditBucket(0.3)).toBe("lt_0_7");
    expect(priceAuditBucket(0.699)).toBe("lt_0_7");
    expect(priceAuditBucket(0.7)).toBe("0_7_0_85");
    expect(priceAuditBucket(0.85)).toBe("0_85_0_95");
    expect(priceAuditBucket(0.949)).toBe("0_85_0_95");
    expect(priceAuditBucket(0.95)).toBe("gte_0_95");
    expect(priceAuditBucket(1)).toBe("gte_0_95");
  });
});
