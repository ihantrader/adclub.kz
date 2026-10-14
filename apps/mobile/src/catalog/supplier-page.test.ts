import { describe, expect, it } from "vitest";
import { reviewMonthText, shareText, supplierName, supplierReviewsView } from "./supplier-page";

// Plain Node checks of M-CAT-09 (TASK-050): the screen only says what the server said.

const visible = {
  viewer: { signedIn: true, clubAccess: true },
  supplier: {
    kind: "visible" as const,
    id: "6f1d0a4e-0000-4000-8000-000000000001",
    name: "Автомаркет",
  },
};

describe("M-CAT-09", () => {
  it("shows a member the name and the reviews", () => {
    expect(supplierName(visible)).toBe("Автомаркет");
    expect(supplierReviewsView(visible, "signed_in", true)).toEqual({
      kind: "list",
      supplierId: visible.supplier.id,
    });
  });

  it("names nobody to a guest and asks them to sign in for the reviews", () => {
    const guest = {
      viewer: { signedIn: false, clubAccess: false },
      supplier: { kind: "hidden" as const, reason: "auth_required" as const },
    };
    expect(supplierName(guest)).toBeNull();
    expect(supplierReviewsView(guest, "guest", null)).toEqual({
      kind: "members-only",
      action: "sign-in",
    });
  });

  it("shows the stand-in of club access to a member without it", () => {
    const member = {
      viewer: { signedIn: true, clubAccess: false },
      supplier: { kind: "hidden" as const, reason: "subscription_required" as const },
    };
    expect(supplierReviewsView(member, "signed_in", true)).toEqual({
      kind: "members-only",
      action: "club-access",
    });
    expect(supplierReviewsView(member, "signed_in", false)).toEqual({
      kind: "members-only",
      action: "register",
    });
  });

  it("never opens the reviews of a supplier the server hid, whatever the viewer says", () => {
    const odd = {
      viewer: { signedIn: true, clubAccess: true },
      supplier: { kind: "hidden" as const, reason: "subscription_required" as const },
    };
    expect(supplierReviewsView(odd, "signed_in", true)).toEqual({
      kind: "members-only",
      action: "club-access",
    });
  });

  it("says a share or «Мало заявок для оценки»", () => {
    const words = {
      share: (n: number) => `Отвечает на ${n}% заявок`,
      fewOrders: "Мало заявок для оценки",
    };
    expect(shareText(80, words)).toBe("Отвечает на 80% заявок");
    expect(shareText(0, words)).toBe("Отвечает на 0% заявок");
    expect(shareText(null, words)).toBe("Мало заявок для оценки");
  });

  it("names the month of a review", () => {
    expect(reviewMonthText("2026-10", "en")).toBe("October 2026");
    expect(reviewMonthText("2026-01", "ru")).toMatch(/январь 2026/);
  });
});
