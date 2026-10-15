import { describe, expect, it } from "vitest";
import { accessSourceText, outcomeText } from "./subscription-words";

describe("the words of a subscription (TASK-040)", () => {
  it("says what an event did, with why", () => {
    expect(outcomeText({ outcome: "applied", detail: null })).toBe("применено");
    expect(outcomeText({ outcome: "no_effect", detail: "stale" })).toBe(
      "без изменений: событие старше уже применённого",
    );
    expect(outcomeText({ outcome: "refused", detail: "linked_to_another_account" })).toBe(
      "отклонено: покупка привязана к другому аккаунту",
    );
    expect(outcomeText({ outcome: "refused", detail: "something_new" })).toBe(
      "отклонено: something_new",
    );
  });

  it("names where access comes from", () => {
    const until = "2026-12-31T18:59:59.000Z";
    expect(accessSourceText({ granted: true, source: "subscription", validUntil: until })).toBe(
      "по подписке",
    );
    expect(accessSourceText({ granted: true, source: "manual", validUntil: until })).toBe(
      "выдан вручную",
    );
    expect(accessSourceText({ granted: false, source: null, validUntil: null })).toBeNull();
  });
});
