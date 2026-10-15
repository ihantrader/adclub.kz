import { describe, expect, it } from "vitest";
import { SubscriptionProviderError, TestSubscriptionProvider } from "./subscription-provider";

const provider = new TestSubscriptionProvider();

describe("the test subscription provider (TASK-040)", () => {
  it("reads its event into our words", () => {
    expect(
      provider.parseEvent({
        id: "e-1",
        kind: "renewed",
        ref: "purchase-1",
        accountId: "11111111-1111-4111-8111-111111111111",
        at: "2026-10-15T06:00:00Z",
        periodEnd: "2026-11-15T06:00:00+05:00",
        platform: "ios",
      }),
    ).toEqual({
      providerEventId: "e-1",
      kind: "renewed",
      providerRef: "purchase-1",
      accountId: "11111111-1111-4111-8111-111111111111",
      eventAt: new Date("2026-10-15T06:00:00Z"),
      periodEnd: new Date("2026-11-15T01:00:00Z"),
      graceUntil: null,
      platform: "ios",
    });
  });

  it("refuses what isn't an event, and an event without its moment", () => {
    for (const raw of [
      null,
      "renewed",
      { id: "e", kind: "bought", ref: "p", at: "2026-10-15T06:00:00Z" },
      { id: "e", kind: "renewed", ref: "p", at: "yesterday" },
      { id: "e", kind: "renewed", ref: "p", at: "2026-10-15T06:00:00Z" },
      { id: "e", kind: "grace_started", ref: "p", at: "2026-10-15T06:00:00Z" },
      { id: "", kind: "expired", ref: "p", at: "2026-10-15T06:00:00Z" },
    ]) {
      expect(() => provider.parseEvent(raw), JSON.stringify(raw)).toThrow(
        SubscriptionProviderError,
      );
    }
  });

  it("checks a purchase's shape and nothing outside the process", async () => {
    await expect(
      provider.verifyPurchase("a", { ref: "p", periodEnd: "2026-11-15T00:00:00Z" }),
    ).resolves.toMatchObject({
      providerRef: "p",
      periodEnd: new Date("2026-11-15T00:00:00Z"),
      platform: null,
    });
    await expect(provider.verifyPurchase("a", { ref: "p" })).rejects.toThrow(
      SubscriptionProviderError,
    );
  });
});
