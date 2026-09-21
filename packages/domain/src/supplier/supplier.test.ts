import { describe, expect, it } from "vitest";
import {
  canOnboardLead,
  supplierLeadStatuses,
  supplierLeadTransition,
  supplierLeadWorkingStatuses,
} from "./supplier-lead";
import { supplierState, supplierVisibleOnShowcase } from "./supplier-state";

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
    const cases = [
      [{ pauseReason: null, blocked: false }, "active", true],
      [{ pauseReason: "billing", blocked: false }, "paused", false],
      [{ pauseReason: "admin", blocked: false }, "paused", false],
      [{ pauseReason: null, blocked: true }, "blocked", false],
      [{ pauseReason: "billing", blocked: true }, "blocked", false],
    ] as const;
    for (const [facts, state, visible] of cases) {
      expect(supplierState(facts)).toBe(state);
      expect(supplierVisibleOnShowcase(facts)).toBe(visible);
    }
  });
});
