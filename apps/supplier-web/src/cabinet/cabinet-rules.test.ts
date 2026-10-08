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
  it("shows nothing for a working company", () => {
    expect(companyBanners({ state: "active", pause: null })).toEqual([]);
  });

  it("shows T-SUP-05 for a pause by the administrator and T-SUP-01 for an unpaid one", () => {
    const since = "2026-10-05T10:00:00.000Z";
    expect(
      companyBanners({ state: "paused", pause: { reason: "admin", note: "Проверка", since } }),
    ).toEqual([{ kind: "paused_admin", tone: "warning", text: "banner.pausedAdmin" }]);
    expect(
      companyBanners({ state: "paused", pause: { reason: "billing", note: null, since } }),
    ).toEqual([{ kind: "paused_billing", tone: "warning", text: "banner.pausedBilling" }]);
  });

  it("shows the block, which wins over a pause", () => {
    expect(
      companyBanners({
        state: "blocked",
        pause: { reason: "admin", note: null, since: "2026-10-05T10:00:00.000Z" },
      }),
    ).toEqual([{ kind: "blocked", tone: "danger", text: "banner.blocked" }]);
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
