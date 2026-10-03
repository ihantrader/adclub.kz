import type { OrderFulfillment, OrderStatusValue } from "@adclub/contracts";
import type { OrderStatusGroup } from "@adclub/ui-core";

/**
 * The state of an order on its screen (SCREENS M-ORD-03, the table of
 * states; DESIGN 7.8, 7.10) — one place for every status the server has
 * for an order on an item in stock. The screen only reads this: what the
 * heading says, what the line under it explains, which deadline it shows,
 * how the code is drawn and how much of the place is known.
 *
 * Texts are keys of the dictionary; what fills them in (`{time}`) is the
 * screen's, because it is a moment of the server in words.
 */

export type CodeDisplay =
  /** Before acceptance: drawn at 30 % with T-ORD-06 over it (DESIGN 7.10). */
  | "dimmed"
  /** Accepted: the code and the QR as they are. */
  | "shown"
  /** «Можно забирать»: the QR one size larger (208). */
  | "large"
  /** A final order has no code at all. */
  | "none";

export type PlaceDisplay =
  /** Before acceptance: the supplier's name, district and city. */
  | "district"
  /** Accepted, ready, given out: the address, hours, «Маршрут», «Позвонить» — as the server gave them. */
  | "full"
  /** Cancelled, declined, expired: nowhere to go. */
  | "none";

export type OrderStatusTitleKey =
  | "orderStatus.created.title"
  | "orderStatus.accepted.title"
  | "orderStatus.readyPickup.title"
  | "orderStatus.readyDelivery.title"
  | "orderStatus.completed.title"
  | "orderStatus.cancelled.title"
  | "orderStatus.declined.title"
  | "orderStatus.responseExpired.title"
  | "orderStatus.reserveExpired.title";

export type OrderStatusTextKey =
  | "orderStatus.created.text"
  | "orderStatus.acceptedPickup.text"
  | "orderStatus.acceptedDelivery.text"
  | "orderStatus.readyPickup.text"
  | "orderStatus.readyDelivery.text"
  | "orderStatus.declined.text"
  | "orderStatus.responseExpired.text"
  | "orderStatus.reserveExpired.text";

export interface OrderStatusView {
  group: OrderStatusGroup;
  title: OrderStatusTitleKey;
  /**
   * The line under the heading; `null` — the table has «—». Its `{time}` is
   * `deadline` in words (the answer is due, the reserve ends).
   */
  text: OrderStatusTextKey | null;
  /** The moment the line or the heading is about; `null` — none. */
  deadline: "respondBy" | "reserveUntil" | "givenOut" | null;
  code: CodeDisplay;
  place: PlaceDisplay;
  /** The order is over: no code, «Повторить заказ» instead of «Отменить заявку». */
  finished: boolean;
  /** «Отменить заявку» is offered (PRODUCT 10.1: until it is given out). */
  cancellable: boolean;
}

/** The fields of an order the state depends on — present in the order and in the saved copy alike. */
export interface OrderStateInput {
  status: OrderStatusValue;
  fulfillment: OrderFulfillment;
}

/**
 * The status of the server, as the table of M-ORD-03 says to show it. A
 * status this version does not know (a newer server, ARCHITECTURE 7.4) is
 * shown as a finished order without a code, never as an active one with a
 * code that might not be valid.
 */
export function orderStatusView({ status, fulfillment }: OrderStateInput): OrderStatusView {
  const pickup = fulfillment === "pickup";
  switch (status) {
    case "created":
      return {
        group: "waiting",
        title: "orderStatus.created.title",
        text: "orderStatus.created.text",
        deadline: "respondBy",
        code: "dimmed",
        place: "district",
        finished: false,
        cancellable: true,
      };
    case "accepted":
      return {
        group: "inProgress",
        title: "orderStatus.accepted.title",
        text: pickup ? "orderStatus.acceptedPickup.text" : "orderStatus.acceptedDelivery.text",
        // The reserve of a pickup order starts when it is accepted (ARCHITECTURE 4.31 I315).
        deadline: pickup ? "reserveUntil" : null,
        code: "shown",
        place: "full",
        finished: false,
        cancellable: true,
      };
    case "ready":
      return pickup
        ? {
            group: "ready",
            title: "orderStatus.readyPickup.title",
            text: "orderStatus.readyPickup.text",
            deadline: "reserveUntil",
            code: "large",
            place: "full",
            finished: false,
            cancellable: true,
          }
        : {
            group: "ready",
            title: "orderStatus.readyDelivery.title",
            text: "orderStatus.readyDelivery.text",
            deadline: null,
            code: "shown",
            place: "full",
            finished: false,
            cancellable: true,
          };
    case "completed":
      // Given out late or closed by the administrator reads the same
      // «Получено» (SCREENS M-ORD-03 «Правила», D-043). «Оцените
      // поставщика» is stage C: no line that asks for what can't be done.
      return {
        group: "finished",
        title: "orderStatus.completed.title",
        text: null,
        deadline: "givenOut",
        code: "none",
        place: "full",
        finished: true,
        cancellable: false,
      };
    case "cancelled_by_user":
      return finished("orderStatus.cancelled.title", null);
    case "declined_by_supplier":
      return finished("orderStatus.declined.title", "orderStatus.declined.text");
    case "response_expired":
      return finished("orderStatus.responseExpired.title", "orderStatus.responseExpired.text");
    case "reserve_expired":
      return finished("orderStatus.reserveExpired.title", "orderStatus.reserveExpired.text");
    default:
      return finished("orderStatus.cancelled.title", null);
  }
}

function finished(title: OrderStatusTitleKey, text: OrderStatusTextKey | null): OrderStatusView {
  return {
    group: "finished",
    title,
    text,
    deadline: null,
    code: "none",
    place: "none",
    finished: true,
    cancellable: false,
  };
}

/** The statuses of an order still going on (the server's `activeOrderStatuses`). */
export function isActiveStatus(status: OrderStatusValue): boolean {
  return status === "created" || status === "accepted" || status === "ready";
}

/**
 * The short status of a card in «Мои заявки» (M-ORD-02): the same words as
 * the heading of the order, except that a given-out order in the history
 * reads «Получено» without its date — the date is a line of its own there.
 */
export function listStatusKey(
  input: OrderStateInput,
): OrderStatusTitleKey | "orderStatus.completed.short" {
  return input.status === "completed"
    ? "orderStatus.completed.short"
    : orderStatusView(input).title;
}
