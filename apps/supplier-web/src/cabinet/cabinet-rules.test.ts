import { describe, expect, it, vi } from "vitest";

// The modules under test import the API client only for their effects.
vi.mock("../api", () => ({ apiClient: {}, onContextChanged: () => () => undefined, session: {} }));

const { canAddMembers, companyBanners, companyStateText } = await import("./company-state");
const { defaultNotificationLanguage } = await import("./notification-language");

describe("adding employees (D-070)", () => {
  it("is offered unless the company is blocked; a pause doesn't matter", () => {
    expect(canAddMembers({ state: "active" })).toBe(true);
    expect(canAddMembers({ state: "paused" })).toBe(true);
    expect(canAddMembers({ state: "blocked" })).toBe(false);
  });
});

describe("banners of the company's state (SCREENS 6.0)", () => {
  const since = "2026-10-05T10:00:00.000Z";
  const none = { admin: null, billing: null };
  const admin = { admin: { note: "Проверка", since }, billing: null };
  const billing = { admin: null, billing: { since } };
  const both = { admin: { note: "Проверка", since }, billing: { since } };

  it("shows nothing for a working company", () => {
    expect(companyBanners({ state: "active", pauses: none })).toEqual([]);
  });

  it("shows T-SUP-05 for a pause by the administrator and T-SUP-01 with «Оплатить» for an unpaid one", () => {
    expect(companyBanners({ state: "paused", pauses: admin })).toEqual([
      { kind: "paused_admin", tone: "warning", text: "banner.pausedAdmin" },
    ]);
    expect(companyBanners({ state: "paused", pauses: billing })).toEqual([
      { kind: "paused_billing", tone: "warning", text: "banner.pausedBilling", action: "pay" },
    ]);
  });

  it("shows both pauses at once, each with its own banner; only the unpaid one has «Оплатить»", () => {
    expect(companyBanners({ state: "paused", pauses: both })).toEqual([
      { kind: "paused_admin", tone: "warning", text: "banner.pausedAdmin" },
      { kind: "paused_billing", tone: "warning", text: "banner.pausedBilling", action: "pay" },
    ]);
  });

  it("shows T-SUP-02 «Привязать карту» while the card is missing, unless the subscription is paused", () => {
    expect(companyBanners({ state: "active", pauses: none }, true)).toEqual([
      { kind: "card_missing", tone: "warning", text: "offers.cardBanner", action: "link_card" },
    ]);
    // The pause says more and asks for payment itself.
    expect(companyBanners({ state: "paused", pauses: billing }, true)).toHaveLength(1);
  });

  it("shows the block, which wins over the administrator's pause but not over paying", () => {
    expect(companyBanners({ state: "blocked", pauses: admin })).toEqual([
      { kind: "blocked", tone: "danger", text: "banner.blocked" },
    ]);
    expect(companyBanners({ state: "blocked", pauses: both })).toEqual([
      { kind: "blocked", tone: "danger", text: "banner.blocked" },
      { kind: "paused_billing", tone: "warning", text: "banner.pausedBilling", action: "pay" },
    ]);
    expect(companyStateText({ state: "blocked" })).toBe("company.stateBlocked");
    expect(companyStateText({ state: "paused" })).toBe("company.statePaused");
    expect(companyStateText({ state: "active" })).toBe("company.stateActive");
  });
});

describe("the default language of notifications (SCREENS 6.0)", () => {
  it("follows a Kazakh interface, keeps Russian for Russian and English", () => {
    expect(defaultNotificationLanguage("kk", "ru")).toBe("kk");
    expect(defaultNotificationLanguage("kk", "kk")).toBeNull();
    expect(defaultNotificationLanguage("ru", "ru")).toBeNull();
    expect(defaultNotificationLanguage("en", "ru")).toBeNull();
    // A choice made by someone is not undone by a Russian interface.
    expect(defaultNotificationLanguage("ru", "kk")).toBeNull();
  });
});
