import { describe, expect, it } from "vitest";
import { deletionRefusal, deletionStoreName, myConsents, refusalOfError } from "./account-deletion";

describe("M-PRO-05", () => {
  it("names the store of the subscription, or of this phone", () => {
    expect(deletionStoreName({ subscriptionPlatform: "android" }, "ios")).toBe("Google Play");
    expect(deletionStoreName({ subscriptionPlatform: "ios" }, "android")).toBe("App Store");
    expect(deletionStoreName({ subscriptionPlatform: null }, "ios")).toBe("App Store");
    expect(deletionStoreName({ subscriptionPlatform: null }, "android")).toBe("Google Play");
    expect(deletionStoreName(null, "web")).toBe("Google Play");
  });

  it("says why the account cannot be deleted", () => {
    expect(deletionRefusal({ blockers: [] })).toBeNull();
    expect(deletionRefusal({ blockers: [{ kind: "administrator" }] })).toEqual({
      key: "deleteAccount.administrator",
    });
    expect(
      deletionRefusal({
        blockers: [
          {
            kind: "last_member",
            supplierId: "00000000-0000-4000-8000-000000000001",
            supplierName: "Автомаркет",
          },
        ],
      }),
    ).toEqual({ key: "deleteAccount.lastMember", company: "Автомаркет" });
    expect(refusalOfError({ reason: "last_member", supplierName: "Шины" })).toEqual({
      key: "deleteAccount.lastMember",
      company: "Шины",
    });
    expect(refusalOfError({ reason: "administrator" })).toEqual({
      key: "deleteAccount.administrator",
    });
    expect(refusalOfError(null)).toBeNull();
  });
});

describe("«Мои согласия»", () => {
  it("shows the latest consent of each kind, in a fixed order", () => {
    const list = myConsents([
      { kind: "terms", version: "a", at: "2026-01-01T00:00:00Z", current: false },
      { kind: "phone_share", version: "p", at: "2026-01-01T00:00:00Z", current: true },
      { kind: "terms", version: "b", at: "2026-02-01T00:00:00Z", current: true },
    ]);
    expect(list.map((entry) => [entry.kind, entry.version])).toEqual([
      ["phone_share", "p"],
      ["terms", "b"],
    ]);
  });
});
