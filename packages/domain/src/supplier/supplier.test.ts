import { describe, expect, it } from "vitest";
import {
  canOnboardLead,
  supplierLeadStatuses,
  supplierLeadTransition,
  supplierLeadWorkingStatuses,
} from "./supplier-lead";
import {
  supplierMayInvite,
  supplierPauseReasons,
  supplierState,
  supplierVisibleOnShowcase,
  type SupplierStateFacts,
} from "./supplier-state";

describe("the funnel of connection requests", () => {
  it("moves freely among the working statuses, without a reason", () => {
    for (const from of supplierLeadWorkingStatuses) {
      for (const to of supplierLeadWorkingStatuses) {
        const transition = supplierLeadTransition(from, to);
        expect(transition, `${from} → ${to}`).toEqual(
          from === to
            ? { allowed: false, refusal: "same" }
            : { allowed: true, reasonRequired: false },
        );
      }
    }
  });

  it("rejects from any working status and returns to work, both with a reason", () => {
    for (const status of supplierLeadWorkingStatuses) {
      expect(supplierLeadTransition(status, "rejected")).toEqual({
        allowed: true,
        reasonRequired: true,
      });
      expect(supplierLeadTransition("rejected", status)).toEqual({
        allowed: true,
        reasonRequired: true,
      });
    }
  });

  it("never sets onboarded by hand, and never leaves it", () => {
    for (const status of supplierLeadStatuses) {
      if (status !== "onboarded") {
        expect(supplierLeadTransition(status, "onboarded")).toEqual({
          allowed: false,
          refusal: "onboarded_only_by_onboarding",
        });
      }
      if (status !== "onboarded") {
        expect(supplierLeadTransition("onboarded", status)).toEqual({
          allowed: false,
          refusal: "final",
        });
      }
    }
  });

  it("creates a supplier only from a request with a signed contract", () => {
    expect(supplierLeadStatuses.filter(canOnboardLead)).toEqual(["contract_signed"]);
  });
});

describe("the state of a supplier", () => {
  it("is visible on the showcase only when neither paused nor blocked", () => {
    const cases: [SupplierStateFacts, string, boolean][] = [
      [{ adminPaused: false, billingPaused: false, blocked: false }, "active", true],
      [{ adminPaused: false, billingPaused: true, blocked: false }, "paused", false],
      [{ adminPaused: true, billingPaused: false, blocked: false }, "paused", false],
      [{ adminPaused: true, billingPaused: true, blocked: false }, "paused", false],
      [{ adminPaused: false, billingPaused: false, blocked: true }, "blocked", false],
      [{ adminPaused: false, billingPaused: true, blocked: true }, "blocked", false],
    ];
    for (const [facts, state, visible] of cases) {
      expect(supplierState(facts)).toBe(state);
      expect(supplierVisibleOnShowcase(facts)).toBe(visible);
    }
  });

  it("keeps the two pauses apart: lifting one leaves the other (TASK-042)", () => {
    const both = { adminPaused: true, billingPaused: true };
    expect(supplierPauseReasons(both)).toEqual(["admin", "billing"]);
    // The administrator lifts theirs: the company stays paused for billing.
    expect(supplierPauseReasons({ ...both, adminPaused: false })).toEqual(["billing"]);
    expect(supplierState({ ...both, adminPaused: false, blocked: false })).toBe("paused");
    // Paying lifts the billing one: the administrator's remains.
    expect(supplierPauseReasons({ ...both, billingPaused: false })).toEqual(["admin"]);
    expect(supplierState({ ...both, billingPaused: false, blocked: false })).toBe("paused");
    expect(supplierPauseReasons({ adminPaused: false, billingPaused: false })).toEqual([]);
  });

  it("adds employees and invites them unless blocked, paused or not (D-070)", () => {
    expect(supplierMayInvite({ blocked: false })).toBe(true);
    expect(supplierMayInvite({ blocked: true })).toBe(false);
    const paused: SupplierStateFacts = { adminPaused: true, billingPaused: false, blocked: false };
    const both: SupplierStateFacts = { adminPaused: false, billingPaused: true, blocked: true };
    expect(supplierMayInvite(paused)).toBe(true);
    expect(supplierMayInvite(both)).toBe(false);
  });
});
