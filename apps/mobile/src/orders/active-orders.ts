import type { ActiveOrder, ActiveOrderMainDate } from "@adclub/contracts";
import { CLUB_TIME_ZONE, deadlineText } from "./order-time";

/**
 * The list «Активные» of M-ORD-02 (TASK-030). The server already answers in
 * the order SCREENS names — «Нужен ваш ответ», then «Можно забирать», then
 * by date (ARCHITECTURE 4.33 I343) — and the app keeps it: this sort is
 * stable and only puts the two named groups first, so on the server's own
 * answer it changes nothing, and the list on the screen and in the copy is
 * one list (TASK-030 requirement 4).
 */
export function orderActiveOrders<T extends Pick<ActiveOrder, "needsAnswer" | "status">>(
  orders: readonly T[],
): T[] {
  const rank = (order: T) => (order.needsAnswer ? 0 : order.status === "ready" ? 1 : 2);
  return orders
    .map((order, index) => ({ order, index }))
    .sort((a, b) => rank(a.order) - rank(b.order) || a.index - b.index)
    .map((entry) => entry.order);
}

/** «Резерв до 15:00, 15 марта» / «Ответит до 14:30» — the main date of a card, as the server chose it. */
export interface MainDateText {
  key:
    | "orders.mainDate.respondBy"
    | "orders.mainDate.reserveUntil"
    | "orders.mainDate.answerBy"
    | "orders.mainDate.visitAt";
  time: string;
}

const MAIN_DATE_KEYS: Record<ActiveOrderMainDate["kind"], MainDateText["key"]> = {
  respond_by: "orders.mainDate.respondBy",
  reserve_until: "orders.mainDate.reserveUntil",
  // TASK-037: «Ответьте до …» while another term waits for the user.
  answer_by: "orders.mainDate.answerBy",
  // TASK-038: the time of a confirmed visit for a service.
  visit_at: "orders.mainDate.visitAt",
};

export function mainDateText(
  mainDate: ActiveOrderMainDate | null,
  timeZone: string | null,
  now: Date,
  monthName: (month: number) => string,
): MainDateText | null {
  if (!mainDate) return null;
  const time = deadlineText(mainDate.at, timeZone ?? CLUB_TIME_ZONE, now, monthName);
  if (time === null) return null;
  // A kind this version does not know (a newer server) says nothing rather than something wrong.
  const key = MAIN_DATE_KEYS[mainDate.kind] as MainDateText["key"] | undefined;
  return key ? { key, time } : null;
}

/**
 * The orders M-ORD-04 leafs through (SCREENS: «активные заявки у того же
 * поставщика листаются «1 из 3»»): those of the same supplier whose code is
 * meant to be shown — accepted or ready (`awaitsReceipt`); a code before
 * acceptance is drawn dimmed and never full-screen. The opened order is
 * always among them, even when the copy does not hold it yet.
 */
export function qrPages<T extends { id: string; supplier: { id: string }; awaitsReceipt: boolean }>(
  opened: T,
  copy: readonly T[],
): { pages: T[]; index: number } {
  const pages = copy.filter(
    (order) => order.awaitsReceipt && order.supplier.id === opened.supplier.id,
  );
  let index = pages.findIndex((order) => order.id === opened.id);
  if (index === -1) {
    pages.unshift(opened);
    index = 0;
  } else {
    // The copy may be older than what the order screen has just loaded.
    pages[index] = opened;
  }
  return { pages, index };
}
