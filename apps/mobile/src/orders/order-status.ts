import type {
  OrderFulfillment,
  OrderKind,
  OrderStatusValue,
  UserOrderStep,
} from "@adclub/contracts";
import type { MobileTextKey } from "@adclub/i18n";
import type { OrderStatusGroup } from "@adclub/ui-core";

/**
 * The state of an order on its screen (SCREENS M-ORD-03, the table of
 * states; DESIGN 7.8, 7.10) — one place for every status the server has
 * for an order on an item in stock and (TASK-037) under order. The screen
 * only reads this: what the heading says, what the line under it explains,
 * which deadline it shows, how the code is drawn and how much of the place
 * is known. The answer to another term («Согласиться» / «Отказаться») is a
 * block of its own (`order-answer.ts`, TASK-039).
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
  | "orderStatus.cancelledByAdmin.title"
  | "orderStatus.declined.title"
  | "orderStatus.responseExpired.title"
  | "orderStatus.reserveExpired.title"
  | "orderStatus.termConfirmed.title"
  | "orderStatus.termProposed.title"
  | "orderStatus.termExpired.title";

export type OrderStatusTextKey =
  | "orderStatus.created.text"
  | "orderStatus.acceptedPickup.text"
  | "orderStatus.acceptedDelivery.text"
  | "orderStatus.readyPickup.text"
  | "orderStatus.readyDelivery.text"
  | "orderStatus.declined.text"
  | "orderStatus.cancelledByAdmin.text"
  | "orderStatus.responseExpired.text"
  | "orderStatus.reserveExpired.text"
  | "orderStatus.termConfirmed.text"
  | "orderStatus.termProposed.text"
  | "orderStatus.termExpired.text";

export interface OrderStatusView {
  group: OrderStatusGroup;
  title: OrderStatusTitleKey;
  /**
   * The line under the heading; `null` — the table has «—». Its `{time}` is
   * `deadline` in words (the answer is due, the reserve ends); its `{date}`
   * (TASK-037) — the date of the term: the proposed one while the user's
   * answer is due, the confirmed one once it is.
   */
  text: OrderStatusTextKey | null;
  /** The moment the line or the heading is about; `null` — none. */
  deadline: "respondBy" | "reserveUntil" | "givenOut" | "answerBy" | null;
  /** TASK-037: which date of the term `{date}` is; `null` — none. */
  termDate: "proposed" | "confirmed" | null;
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
  /** TASK-037: «Принята» of an order under order reads «Поставщик подтвердил срок». */
  kind?: OrderKind;
}

/**
 * The status of the server, as the table of M-ORD-03 says to show it. A
 * status this version does not know (a newer server, ARCHITECTURE 7.4) is
 * shown as a finished order without a code, never as an active one with a
 * code that might not be valid.
 */
export function orderStatusView({ status, fulfillment, kind }: OrderStateInput): OrderStatusView {
  const pickup = fulfillment === "pickup";
  switch (status) {
    case "created":
      return {
        group: "waiting",
        title: "orderStatus.created.title",
        text: "orderStatus.created.text",
        deadline: "respondBy",
        termDate: null,
        code: "dimmed",
        place: "district",
        finished: false,
        cancellable: true,
      };
    case "term_proposed":
      // TASK-037: another term waits for the user's word (SCREENS M-ORD-03
      // «Нужен ваш ответ»); the buttons of the answer are `termAnswer` (TASK-039).
      return {
        group: "waiting",
        title: "orderStatus.termProposed.title",
        text: "orderStatus.termProposed.text",
        deadline: "answerBy",
        termDate: "proposed",
        code: "dimmed",
        place: "district",
        finished: false,
        cancellable: true,
      };
    case "accepted":
      if (kind === "on_order") {
        // «Срок подтверждён»: the goods are not there yet, so no reserve —
        // the line says when the supplier brings them.
        return {
          group: "inProgress",
          title: "orderStatus.termConfirmed.title",
          text: "orderStatus.termConfirmed.text",
          deadline: null,
          termDate: "confirmed",
          code: "shown",
          place: "full",
          finished: false,
          cancellable: true,
        };
      }
      return {
        group: "inProgress",
        title: "orderStatus.accepted.title",
        text: pickup ? "orderStatus.acceptedPickup.text" : "orderStatus.acceptedDelivery.text",
        // The reserve of a pickup order starts when it is accepted (ARCHITECTURE 4.31 I315).
        deadline: pickup ? "reserveUntil" : null,
        termDate: null,
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
            termDate: null,
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
            termDate: null,
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
        termDate: null,
        code: "none",
        place: "full",
        finished: true,
        cancellable: false,
      };
    case "cancelled_by_user":
      return finished("orderStatus.cancelled.title", null);
    case "cancelled_by_admin":
      // TASK-036.B: never «Вы отменили» — the club's administrator did.
      return finished("orderStatus.cancelledByAdmin.title", "orderStatus.cancelledByAdmin.text");
    case "declined_by_supplier":
      return finished("orderStatus.declined.title", "orderStatus.declined.text");
    case "response_expired":
      return finished("orderStatus.responseExpired.title", "orderStatus.responseExpired.text");
    case "reserve_expired":
      return finished("orderStatus.reserveExpired.title", "orderStatus.reserveExpired.text");
    case "term_expired":
      // TASK-037: the user did not answer another term in time.
      return finished("orderStatus.termExpired.title", "orderStatus.termExpired.text");
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
    termDate: null,
    code: "none",
    place: "none",
    finished: true,
    cancellable: false,
  };
}

export type OrderMarkKey =
  | "orderStatus.short.created"
  | "orderStatus.short.accepted"
  | "orderStatus.short.ready"
  | "orderStatus.short.finished";

/**
 * The mark over the heading of an order (M-ORD-03): the name of its group —
 * «Ожидание», «В работе», «Готово», «Завершена» — and never the heading's
 * own words. A mark that repeats the heading («Можно забирать» over
 * «Можно забирать», TASK-030 acceptance) says nothing twice.
 */
export function orderMarkKey(input: OrderStateInput): OrderMarkKey {
  switch (orderStatusView(input).group) {
    case "waiting":
      return "orderStatus.short.created";
    case "inProgress":
      return "orderStatus.short.accepted";
    case "ready":
      return "orderStatus.short.ready";
    default:
      return "orderStatus.short.finished";
  }
}

/** The statuses of an order still going on (the server's `activeOrderStatuses`). */
export function isActiveStatus(status: OrderStatusValue): boolean {
  return (
    status === "created" ||
    status === "accepted" ||
    status === "ready" ||
    // TASK-037: an order under order whose other term waits for the user.
    status === "term_proposed"
  );
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

/**
 * A step of «Ход заявки» (M-ORD-03) by the move that made it and the status
 * it led to — never an employee's name. The steps of a term of an order
 * under order (TASK-039) are told by their move: the supplier confirmed it,
 * proposed another, the user agreed or said no.
 */
export function orderStepKey(
  step: Pick<UserOrderStep, "action" | "status">,
  order: { fulfillment: OrderFulfillment; kind?: OrderKind },
): MobileTextKey {
  switch (step.action) {
    case "propose_term":
      return "order.step.termProposed";
    case "agree_term":
      return "order.step.termAgreed";
    case "reject_term":
      return "order.step.termRejected";
    case "accept":
      if (order.kind === "on_order") return "order.step.termConfirmed";
      break;
    default:
      break;
  }
  switch (step.status) {
    case "created":
      return "order.step.created";
    case "accepted":
      return "orderStatus.accepted.title";
    case "ready":
      return order.fulfillment === "pickup"
        ? "orderStatus.readyPickup.title"
        : "orderStatus.readyDelivery.title";
    case "completed":
      return "orderStatus.completed.short";
    case "cancelled_by_user":
      return "orderStatus.cancelled.title";
    case "cancelled_by_admin":
      return "orderStatus.cancelledByAdmin.title";
    case "declined_by_supplier":
      return "orderStatus.declined.title";
    case "response_expired":
      return "orderStatus.responseExpired.title";
    case "reserve_expired":
      return "orderStatus.reserveExpired.title";
    case "term_expired":
      return "orderStatus.termExpired.title";
    default:
      return "order.step.changed";
  }
}
