import { describe, expect, it } from "vitest";
import {
  inNextDigest,
  moderationDecisionOutcome,
  moderationDigestCounts,
  moderationDigestDue,
  moderationDigestKey,
  type ModerationDecision,
} from "./moderation-digest";

const AT = new Date("2026-11-16T10:00:00Z");

function decision(patch: Partial<ModerationDecision>): ModerationDecision {
  return { kind: "item_request", status: "approved", decidedAt: AT, digestedAt: null, ...patch };
}

describe("W-06 — what a decision counts as", () => {
  it("«добавлено» — an item made or matched, a proposal approved; «отклонено» — rejected", () => {
    expect(moderationDecisionOutcome({ status: "approved" })).toBe("added");
    expect(moderationDecisionOutcome({ status: "rejected" })).toBe("rejected");
    expect(moderationDecisionOutcome({ status: "new" })).toBeNull();
    expect(moderationDecisionOutcome({ status: "pending" })).toBeNull();
  });

  it("counts both kinds together", () => {
    const counts = moderationDigestCounts([
      decision({}),
      decision({ kind: "compatibility" }),
      decision({ kind: "compatibility", status: "rejected" }),
      decision({ status: "rejected" }),
      decision({ status: "rejected" }),
      decision({ status: "new", decidedAt: null }),
      decision({ kind: "compatibility", status: "pending", decidedAt: null }),
    ]);
    expect(counts).toEqual({ added: 2, rejected: 3 });
    expect(moderationDigestDue(counts)).toBe(true);
    expect(moderationDigestDue({ added: 0, rejected: 0 })).toBe(false);
  });
});

describe("W-06 — the boundary of a digest", () => {
  it("takes a decision once: decided and in no digest yet", () => {
    expect(inNextDigest(decision({}))).toBe(true);
    expect(inNextDigest(decision({ digestedAt: AT }))).toBe(false);
    // Still waiting — the next digest after its decision takes it.
    expect(inNextDigest(decision({ status: "new", decidedAt: null }))).toBe(false);
    expect(
      inNextDigest(decision({ kind: "compatibility", status: "pending", decidedAt: null })),
    ).toBe(false);
  });

  it("keys a message by company, day of Almaty and recipient", () => {
    expect(moderationDigestKey("s1", "2026-11-16", "m1")).toBe(
      "moderation_digest:s1:2026-11-16:m1",
    );
    expect(moderationDigestKey("s1", "2026-11-17", "m1")).not.toBe(
      moderationDigestKey("s1", "2026-11-16", "m1"),
    );
  });
});
