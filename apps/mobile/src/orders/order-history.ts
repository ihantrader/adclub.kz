import type { UserHistoryMonth, UserOrderHistoryPage } from "@adclub/contracts";

/**
 * «История» of M-ORD-02 page by page (TASK-030). The server pages by the
 * moment an order finished and groups by month in the club's zone
 * (ARCHITECTURE 4.33 I345); a month cut by a page comes again at the top of
 * the next one, and the app joins the groups by their name. An order is
 * never shown twice, whatever the pages hold: the first place it appeared
 * in stays its place.
 */
export interface HistoryState {
  months: UserHistoryMonth[];
  total: number;
  nextCursor: string | null;
}

export const EMPTY_HISTORY: HistoryState = { months: [], total: 0, nextCursor: null };

export function appendHistoryPage(state: HistoryState, page: UserOrderHistoryPage): HistoryState {
  const seen = new Set(state.months.flatMap((month) => month.orders.map((order) => order.id)));
  const months = state.months.map((month) => ({ ...month, orders: [...month.orders] }));
  for (const month of page.months) {
    const fresh = month.orders.filter((order) => {
      if (seen.has(order.id)) return false;
      seen.add(order.id);
      return true;
    });
    if (fresh.length === 0) continue;
    const existing = months.find((candidate) => candidate.month === month.month);
    if (existing) existing.orders.push(...fresh);
    else months.push({ month: month.month, orders: fresh });
  }
  return { months, total: page.total, nextCursor: page.nextCursor };
}

/** `YYYY-MM` → its parts, for «Октябрь 2026»; `null` for anything else. */
export function monthOf(month: string): { year: number; month: number } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return null;
  const value = Number(match[2]);
  return value >= 1 && value <= 12 ? { year: Number(match[1]), month: value } : null;
}
