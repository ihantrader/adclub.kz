import { describe, expect, it } from "vitest";
import type { AdminBillingSupplier } from "@adclub/contracts";
import { locationOf, menuOf } from "../router";
import {
  daysText,
  failedFacts,
  groupsOf,
  paymentsPath,
  paymentsTabOf,
  periodOf,
  planRefusal,
  userSubscriptionFiltersOf,
  userSubscriptionsPath,
} from "./billing-words";

describe("«Биллинг» of the admin panel (TASK-043)", () => {
  it("has its pages in the menu's section", () => {
    for (const path of ["/billing", "/billing/users", "/billing/payments", "/billing/plans"]) {
      const route = locationOf(path).route!;
      expect(menuOf(route)).toBe("billing");
    }
  });

  it("takes the last 30 days of Almaty by default and the days of the address otherwise", () => {
    // 20:00 UTC on 3 November is 01:00 of 4 November in Almaty.
    const now = new Date("2026-11-03T20:00:00Z");
    expect(periodOf(new URLSearchParams(), now)).toEqual({
      fromDay: "2026-10-06",
      toDay: "2026-11-04",
      from: "2026-10-05T19:00:00.000Z",
      to: "2026-11-04T19:00:00.000Z",
    });
    const chosen = periodOf(new URLSearchParams("from=2026-10-01&to=2026-10-31"), now);
    expect(chosen).toMatchObject({
      from: "2026-09-30T19:00:00.000Z",
      to: "2026-10-31T19:00:00.000Z",
    });
  });

  it("reads the users' filters as the summary's cards write them", () => {
    const filters = userSubscriptionFiltersOf(
      new URLSearchParams("tab=all&startedFrom=2026-10-06&startedTo=2026-11-04&platform=ios"),
    );
    // The same instants the summary counted with: `to` is the next day's 00:00.
    expect(filters).toMatchObject({
      tab: "all",
      platform: "ios",
      startedFrom: "2026-10-05T19:00:00.000Z",
      startedTo: "2026-11-04T19:00:00.000Z",
    });
    expect(userSubscriptionFiltersOf(new URLSearchParams("tab=nonsense&platform=x"))).toMatchObject(
      {
        tab: "active",
        platform: undefined,
      },
    );
    expect(userSubscriptionsPath("a")).toBe("/billing/users?tab=all&accountId=a");
  });

  it("opens «Неуспешные» for the failure groups and «Все поставщики» for the others", () => {
    expect(paymentsPath(["declined", "paused"])).toBe("/billing/payments?groups=declined%2Cpaused");
    expect(paymentsPath(["paid"])).toBe("/billing/payments?tab=suppliers&groups=paid");
    const query = new URLSearchParams("tab=suppliers&groups=paid,nonsense,none");
    expect(paymentsTabOf(query)).toBe("suppliers");
    expect(groupsOf(query)).toEqual(["paid", "none"]);
    expect(paymentsTabOf(new URLSearchParams())).toBe("failed");
  });

  it("says the next try and the days to the pause from the server's facts", () => {
    const row: AdminBillingSupplier = {
      supplierId: "s",
      name: "Автомаркет",
      group: "declined",
      subscriptionStatus: "past_due",
      periodEnd: "2026-11-01T19:00:00.000Z",
      cardMask: "9995",
      pausedSince: null,
      adminPaused: false,
      lastDecline: { at: "2026-11-02T05:00:05.000Z", reason: "insufficient_funds", amount: 1000 },
      declines: 2,
      nextRetryAt: null,
      pauseAt: "2026-11-05T05:00:05.000Z",
      daysToPause: 2,
      waiting: null,
    };
    expect(failedFacts(row).next).toBe("Автоматических попыток больше не будет");
    expect(failedFacts(row).pause).toMatch(/через 2 дня$/);
    expect(failedFacts({ ...row, group: "paused", pausedSince: row.pauseAt }).next).toBe(
      "Автоматических попыток больше не будет",
    );
    expect(daysText(0)).toBe("сегодня");
    expect(daysText(1)).toBe("через 1 день");
    expect(daysText(5)).toBe("через 5 дней");
    expect(daysText(11)).toBe("через 11 дней");
    expect(daysText(22)).toBe("через 22 дня");
  });

  it("says a refusal of a new tariff at its field, with the nearest day of a rise", async () => {
    const { ApiError } = await import("@adclub/api-client");
    const refusal = planRefusal(
      new ApiError({
        status: 400,
        code: "VALIDATION_ERROR",
        message: "A rise",
        retryable: false,
        details: [{ path: "startsOn", message: "A rise", earliest: "2026-11-12", rise: true }],
      }),
    );
    expect(refusal).toMatchObject({ field: "startsOn", earliest: "2026-11-12" });
    expect(refusal!.text).toMatch(/^Повышение можно начать не раньше 12/);
  });
});
