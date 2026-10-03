import type { UserHistoryOrder, UserOrderHistoryPage } from "@adclub/contracts";
import { describe, expect, it } from "vitest";
import { appendHistoryPage, EMPTY_HISTORY, monthOf } from "./order-history";

// Plain Node checks of «История» page by page (M-ORD-02, TASK-030, AC-6).

function entry(id: string): UserHistoryOrder {
  return { id } as UserHistoryOrder;
}

function page(
  months: Array<[string, string[]]>,
  nextCursor: string | null,
  total = 9,
): UserOrderHistoryPage {
  return {
    language: "ru",
    timeZone: "Asia/Almaty",
    months: months.map(([month, ids]) => ({ month, orders: ids.map(entry) })),
    total,
    nextCursor,
  };
}

describe("the history in pages", () => {
  it("joins a month cut by a page and keeps the months in the server's order", () => {
    let state = appendHistoryPage(EMPTY_HISTORY, page([["2026-10", ["a", "b"]]], "c1"));
    state = appendHistoryPage(
      state,
      page(
        [
          ["2026-10", ["c"]],
          ["2026-09", ["d"]],
        ],
        null,
      ),
    );
    expect(
      state.months.map((month) => [month.month, month.orders.map((order) => order.id)]),
    ).toEqual([
      ["2026-10", ["a", "b", "c"]],
      ["2026-09", ["d"]],
    ]);
    expect(state.nextCursor).toBeNull();
    expect(state.total).toBe(9);
  });

  it("never shows an order twice, whatever the pages repeat", () => {
    let state = appendHistoryPage(EMPTY_HISTORY, page([["2026-10", ["a", "b"]]], "c1"));
    state = appendHistoryPage(state, page([["2026-10", ["b", "c"]]], "c2"));
    state = appendHistoryPage(
      state,
      page(
        [
          ["2026-10", ["c"]],
          ["2026-08", ["e"]],
        ],
        null,
      ),
    );
    const ids = state.months.flatMap((month) => month.orders.map((order) => order.id));
    expect(ids).toEqual(["a", "b", "c", "e"]);
  });

  it("starts empty, and an empty history is told apart by the server's total", () => {
    const state = appendHistoryPage(EMPTY_HISTORY, page([], null, 0));
    expect(state).toEqual({ months: [], total: 0, nextCursor: null });
  });

  it("reads a month of the server", () => {
    expect(monthOf("2026-10")).toEqual({ year: 2026, month: 10 });
    expect(monthOf("2026-13")).toBeNull();
    expect(monthOf("October")).toBeNull();
  });
});
