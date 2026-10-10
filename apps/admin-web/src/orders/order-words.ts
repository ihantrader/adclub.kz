import { isApiError } from "@adclub/api-client";
import {
  orderStateConflictDetailsSchema,
  type AdminOrder,
  type AdminOrderListQuery,
  type OrderActor,
  type OrderEvent,
  type OrderEventAction,
  type OrderStatusValue,
} from "@adclub/contracts";
import { orderTransition } from "@adclub/domain";
import { actionErrorText, validationText } from "../errors";
import { formatMoment } from "../format";

/**
 * The words of «Заявки» (TASK-036.B; SCREENS A-ORD-01…03, 7.0): what the
 * server's answers mean in plain Russian, and which manual actions an order
 * offers — read from the one table of moves (`orderTransition` of
 * `@adclub/domain`), so the screen never offers what the server would
 * refuse. Nothing here decides anything; the server checks it all again.
 */

export const ORDER_STATUS_TEXT: Record<OrderStatusValue, string> = {
  created: "Ждёт ответа",
  accepted: "Принята",
  ready: "Готова к выдаче",
  completed: "Выдана",
  cancelled_by_user: "Отменена клиентом",
  declined_by_supplier: "Отклонена поставщиком",
  response_expired: "Нет ответа вовремя",
  reserve_expired: "Срок резерва истёк",
  cancelled_by_admin: "Отменена администратором",
};

/** The statuses the filter offers, in the order of an order's life. */
export const ORDER_STATUSES = Object.keys(ORDER_STATUS_TEXT) as OrderStatusValue[];

/** The colour of a status mark (DESIGN 7.8): waiting, going on, done well, done otherwise. */
export function statusTone(status: OrderStatusValue): string {
  switch (status) {
    case "created":
      return "status--open";
    case "accepted":
    case "ready":
      return "status--acknowledged";
    case "completed":
      return "status--done";
    default:
      return "status--closed";
  }
}

export const FULFILLMENT_TEXT = { pickup: "Самовывоз", delivery: "Доставка" } as const;

export const DECLINE_REASON_TEXT = {
  out_of_stock: "нет в наличии",
  cannot_meet_term: "не могут в этот срок",
  other: "другое",
} as const;

/** Who did something to an order, for the administrator (employees by name). */
export function orderActorText(actor: OrderActor, admins?: Map<string, string | null>): string {
  switch (actor.kind) {
    case "user":
      return "Клиент";
    case "member":
      return `${actor.name || "Сотрудник"}${actor.removed ? " (удалён)" : ""}`;
    case "admin": {
      const name = admins?.get(actor.adminId);
      return name ? `${name} (администратор)` : "Администратор клуба";
    }
    case "system":
      return "Система";
  }
}

const ATTEMPT_TEXT: Partial<Record<OrderEventAction, string>> = {
  accept: "принять",
  decline: "отказать",
  mark_ready: "отметить готовность",
  close: "выдать",
  close_late: "выдать поздно",
  admin_close: "закрыть без кода",
  admin_cancel: "отменить",
  cancel: "отменить",
};

/** One entry of the order's journal in words (A-ORD-02 «журнал с актором»). */
export function eventText(event: OrderEvent): string {
  const details = event.details;
  switch (event.action) {
    case "create":
      return "Заявка оформлена";
    case "accept":
      return "Принята";
    case "decline":
      return details.reason
        ? `Отклонена: ${DECLINE_REASON_TEXT[details.reason]}${details.note ? ` («${details.note}»)` : ""}`
        : "Отклонена";
    case "mark_ready":
      return "Готова к выдаче";
    case "close":
      return details.closeMethod === "qr" ? "Выдана по QR" : "Выдана по коду";
    case "close_late":
      return "Выдана поздно (в окне позднего закрытия)";
    case "admin_close":
      return "Закрыта без кода";
    case "admin_cancel":
      return "Отменена администратором";
    case "cancel":
      return "Отменена клиентом";
    case "expire_no_response":
      return "Поставщик не ответил вовремя";
    case "expire_reserve":
      return "Клиент не пришёл: резерв истёк";
    case "reserve_expiring":
      return `Резерв скоро истечёт (${formatMoment(details.deadline)})`;
    case "late_action_ignored":
      return `Нажатие опоздало: пытались ${ATTEMPT_TEXT[details.attemptedAction ?? "accept"] ?? "изменить"}`;
    case "deadline_extended":
      return `Продлён ${details.extendedDeadline === "reserve" ? "резерв" : "срок ответа"} на ${details.minutes ?? "?"} мин: ${formatMoment(details.previousDeadline)} → ${formatMoment(details.deadline)}`;
  }
}

/** «через WhatsApp» and the like, after the actor. */
export function channelText(event: OrderEvent): string | null {
  return event.channel === "whatsapp" ? "через WhatsApp" : null;
}

/** Which manual actions the order offers now (the one table of moves). */
export function orderActions(order: Pick<AdminOrder, "status" | "deadlines">): {
  extendResponse: boolean;
  extendReserve: boolean;
  closeWithoutCode: boolean;
  cancel: boolean;
} {
  return {
    extendResponse: order.status === "created",
    extendReserve:
      (order.status === "accepted" || order.status === "ready") &&
      order.deadlines.reserveUntil !== null,
    closeWithoutCode: orderTransition(order.status, "admin_close") !== null,
    cancel: orderTransition(order.status, "admin_cancel") !== null,
  };
}

/** SCREENS 7.5 «Закрыть без кода» — the confirmation, as the screen writes it. */
export const CLOSE_WITHOUT_CODE_TEXT =
  "Клиент получит уведомление о закрытии и сможет сообщить, что не получал товар. Заявка будет помечена «Закрыта администратором».";

/** What the cancel does, for its confirmation. */
export const CANCEL_TEXT =
  "Заявка станет «Отменена администратором»: поставщик увидит это в кабинете, клиент — в приложении. Сообщение в WhatsApp не отправляется. Причина видна только администраторам.";

const LAST_ACTION_TEXT: Partial<Record<OrderEventAction, string>> = {
  accept: "приняли",
  decline: "отклонили",
  mark_ready: "отметили готовой",
  close: "выдали",
  close_late: "выдали",
  admin_close: "закрыли без кода",
  admin_cancel: "отменили",
  cancel: "отменил клиент",
  expire_no_response: "истекла: поставщик не ответил",
  expire_reserve: "истекла: клиент не пришёл",
};

/**
 * A refused action on an order in words (SCREENS 7.0): someone acted first
 * — who and when, from the server's `lastAction` — a deadline passed, a
 * limit of the extension; the typed reason stays in the dialog.
 */
export function orderErrorText(error: unknown, admins?: Map<string, string | null>): string {
  if (!isApiError(error)) return actionErrorText(error);
  if (error.code === "ORDER_STATE_CONFLICT") {
    const parsed = orderStateConflictDetailsSchema.safeParse(error.details);
    if (!parsed.success) return "Заявка уже изменилась. Обновите страницу";
    const { lastAction, currentStatus } = parsed.data;
    if (!lastAction) {
      return `Заявка уже в другом состоянии: ${ORDER_STATUS_TEXT[currentStatus]}. Обновите страницу`;
    }
    const what = LAST_ACTION_TEXT[lastAction.action] ?? "изменили";
    const who =
      lastAction.actor.kind === "system" ? "" : ` — ${orderActorText(lastAction.actor, admins)}`;
    const verb = lastAction.action.startsWith("expire_") ? "Заявка" : "Заявку уже";
    return `${verb} ${what}${who}, ${formatMoment(lastAction.at)}. Сейчас: ${ORDER_STATUS_TEXT[currentStatus]}`;
  }
  if (error.code === "VALIDATION_ERROR") {
    return validationText(error) ?? "Проверьте введённое";
  }
  return actionErrorText(error);
}

/** Why «Продлить все» left an order as it was (A-ORD-03). */
export const SKIP_REASON_TEXT = {
  changed: "заявка изменилась после того, как список открыли",
  not_waiting: "заявка уже не ждёт ответа (принята, отклонена или отменена)",
  expired: "срок уже прошёл",
  not_found: "заявки нет",
} as const;

/** The filters of A-ORD-01 kept in the address, for the server. */
export function orderFiltersOf(query: URLSearchParams): Omit<AdminOrderListQuery, "limit"> {
  const status = query.get("status");
  const value = (name: string) => query.get(name)?.trim() || undefined;
  return {
    q: value("q"),
    status: ORDER_STATUSES.includes(status as OrderStatusValue)
      ? (status as OrderStatusValue)
      : undefined,
    supplierId: value("supplierId"),
    accountId: value("accountId"),
    cityId: value("cityId"),
    from: almatyStart(value("from")),
    to: almatyStart(value("to"), 1),
    test: query.get("test") === "include" ? "include" : "exclude",
    closedLate: query.get("closedLate") === "true" ? "true" : undefined,
    closedByAdmin: query.get("closedByAdmin") === "true" ? "true" : undefined,
  };
}

/** The start of a day of Almaty (UTC+5), as the API takes a period. */
function almatyStart(date: string | undefined, plusDays = 0): string | undefined {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const start = new Date(`${date}T00:00:00+05:00`);
  start.setUTCDate(start.getUTCDate() + plusDays);
  return start.toISOString();
}

/** «12 500 ₸». */
export function moneyText(amount: number): string {
  return `${amount.toLocaleString("ru-RU")} ₸`;
}
