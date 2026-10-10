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
  // TASK-037: an order under order.
  term_proposed: "Ждёт ответа клиента на срок",
  term_expired: "Клиент не ответил на срок",
  // TASK-038: a service.
  no_show: "Неявка клиента",
  visit_unresolved: "Запись не разобрана",
};

/**
 * «Принята» of an order under order is «Срок подтверждён» (TASK-037); of a
 * service — «Подтверждена на время», and its talk is of a time, not a term
 * (TASK-038).
 */
export function orderStatusText(order: Pick<AdminOrder, "status" | "kind">): string {
  if (order.kind === "service") {
    if (order.status === "accepted") return "Подтверждена на время";
    if (order.status === "term_proposed") return "Ждёт ответа клиента на время";
    if (order.status === "term_expired") return "Клиент не ответил на время";
  }
  return order.status === "accepted" && order.kind === "on_order"
    ? "Срок подтверждён"
    : ORDER_STATUS_TEXT[order.status];
}

/** «Под заказ» (TASK-037) or «Услуга» (TASK-038) next to the number; `null` — an item in stock. */
export function orderKindText(kind: AdminOrder["kind"]): string | null {
  return kind === "on_order" ? "Под заказ" : kind === "service" ? "Услуга" : null;
}

/**
 * The term of an order under order line by line (A-ORD-02, TASK-039): the
 * one the customer agreed to by ordering, another one the supplier
 * proposed (and until when the customer answers, while they decide), the
 * confirmed one, and an overdue supply. Empty — an item in stock.
 */
export function orderTermLines(
  order: Pick<AdminOrder, "status" | "onOrderTerm"> & Partial<Pick<AdminOrder, "serviceVisit">>,
): { label: string; text: string }[] {
  if (order.serviceVisit) return visitLines(order.status, order.serviceVisit);
  const term = order.onOrderTerm;
  if (!term) return [];
  const day = (date: string | null) => (date ? formatDay(date) : "—");
  const lines = [
    {
      label: "Срок при оформлении",
      text: `${term.expected.leadDays} раб. дн., до ${day(term.expected.readyOn)}`,
    },
  ];
  if (term.proposed) {
    lines.push({
      label: "Предложен другой срок",
      text:
        `${term.proposed.leadDays} раб. дн., до ${day(term.proposed.readyOn)}; предложен ${formatMoment(term.proposed.at)}` +
        (order.status === "term_proposed"
          ? `; клиент ответит до ${formatMoment(term.proposed.answerBy)}`
          : ""),
    });
  }
  if (term.confirmed) {
    lines.push({
      label: "Срок подтверждён",
      text: `${term.confirmed.leadDays} раб. дн., до ${day(term.confirmed.readyOn)}; ${formatMoment(term.confirmed.at)}`,
    });
  }
  if (term.overdueSince) {
    lines.push({
      label: "Срок поставки прошёл",
      text: `поставка просрочена с ${formatMoment(term.overdueSince)}`,
    });
  }
  return lines;
}

/**
 * The visit of an order on a service line by line (A-ORD-02, TASK-038): the
 * car, the time the customer asked for, another time the supplier proposed
 * (and until when the customer answers, while they decide), the confirmed
 * time and the end of its window.
 */
function visitLines(
  status: AdminOrder["status"],
  visit: NonNullable<AdminOrder["serviceVisit"]>,
): { label: string; text: string }[] {
  const car = [visit.car.make.label, visit.car.model.label, visit.car.year ?? ""].join(" ").trim();
  const lines = [
    { label: "Автомобиль", text: car },
    { label: "Желаемое время", text: formatMoment(visit.desiredAt) },
  ];
  if (visit.proposed) {
    lines.push({
      label: "Предложено другое время",
      text:
        `${formatMoment(visit.proposed.visitAt)}; предложено ${formatMoment(visit.proposed.at)}` +
        (status === "term_proposed"
          ? `; клиент ответит до ${formatMoment(visit.proposed.answerBy)}`
          : ""),
    });
  }
  if (visit.confirmed) {
    lines.push({
      label: "Время визита",
      text: `${formatMoment(visit.confirmed.visitAt)}; подтверждено ${formatMoment(visit.confirmed.at)}; неявку можно отметить до ${formatMoment(visit.confirmed.until)}`,
    });
  }
  return lines;
}

const MONTHS = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
];

/** «11 октября» of a calendar date `YYYY-MM-DD`. */
function formatDay(date: string): string {
  const [, month = 1, day = 1] = date.split("-").map(Number);
  return `${String(day)} ${MONTHS[month - 1] ?? ""}`;
}

/** The statuses the filter offers, in the order of an order's life. */
export const ORDER_STATUSES = Object.keys(ORDER_STATUS_TEXT) as OrderStatusValue[];

/** The colour of a status mark (DESIGN 7.8): waiting, going on, done well, done otherwise. */
export function statusTone(status: OrderStatusValue): string {
  switch (status) {
    case "created":
    case "term_proposed":
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
  propose_term: "предложить другой срок",
  agree_term: "согласиться на срок",
  reject_term: "отказаться от срока",
  propose_time: "предложить другое время",
  mark_no_show: "отметить неявку",
};

/**
 * One entry of the order's journal in words (A-ORD-02 «журнал с актором»);
 * `kind` — the order's: a service talks of a time (TASK-038).
 */
export function eventText(event: OrderEvent, kind: AdminOrder["kind"] = "stock"): string {
  const details = event.details;
  const service = kind === "service";
  switch (event.action) {
    case "create":
      return service && details.visitAt
        ? `Запись оформлена на ${formatMoment(details.visitAt)}`
        : "Заявка оформлена";
    case "accept":
      return service
        ? `Время подтверждено${details.visitAt ? `: ${formatMoment(details.visitAt)}` : ""}`
        : "Принята";
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
      return `Продлён ${
        details.extendedDeadline === "reserve"
          ? "резерв"
          : details.extendedDeadline === "term"
            ? "срок ответа клиента"
            : "срок ответа"
      } на ${details.minutes ?? "?"} мин: ${formatMoment(details.previousDeadline)} → ${formatMoment(details.deadline)}`;
    // TASK-037: the term of an order under order.
    case "propose_term":
      return `Предложен другой срок: ${details.leadDays ?? "?"} раб. дн., до ${details.readyOn ? formatDay(details.readyOn) : "—"}; клиент ответит до ${formatMoment(details.answerBy)}`;
    case "agree_term":
      return service
        ? `Клиент согласился на время${details.visitAt ? ` ${formatMoment(details.visitAt)}` : ""}`
        : "Клиент согласился на срок";
    case "reject_term":
      return service ? "Клиент отказался от времени" : "Клиент отказался от срока";
    case "expire_term":
      return service ? "Клиент не ответил на время вовремя" : "Клиент не ответил на срок вовремя";
    // TASK-038: a service.
    case "propose_time":
      return `Предложено другое время: ${formatMoment(details.visitAt)}; клиент ответит до ${formatMoment(details.answerBy)}`;
    case "mark_no_show":
      return "Отмечена неявка клиента";
    case "expire_visit":
      return "Запись не разобрана: никто не отметил выполнение или неявку";
    case "late_cancel":
      return `Поздняя отмена: меньше установленного срока до визита${details.visitAt ? ` (${formatMoment(details.visitAt)})` : ""}`;
    case "supply_overdue":
      return `Срок поставки прошёл${details.readyOn ? ` (${formatDay(details.readyOn)})` : ""}, заявка не готова`;
  }
}

/** «через WhatsApp» and the like, after the actor. */
export function channelText(event: OrderEvent): string | null {
  return event.channel === "whatsapp" ? "через WhatsApp" : null;
}

/** Which manual actions the order offers now (the one table of moves). */
export function orderActions(order: Pick<AdminOrder, "status" | "kind" | "deadlines">): {
  extendResponse: boolean;
  extendReserve: boolean;
  /** TASK-039: the customer's answer to another term (deadline «term»). */
  extendTerm: boolean;
  closeWithoutCode: boolean;
  cancel: boolean;
} {
  return {
    extendResponse: order.status === "created",
    extendTerm: order.status === "term_proposed" && order.deadlines.termAnswerBy !== null,
    extendReserve:
      (order.status === "accepted" || order.status === "ready") &&
      order.deadlines.reserveUntil !== null,
    closeWithoutCode: orderTransition(order.status, "admin_close", order.kind) !== null,
    cancel: orderTransition(order.status, "admin_cancel", order.kind) !== null,
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
  propose_term: "предложили другой срок",
  agree_term: "клиент согласился на срок",
  reject_term: "клиент отказался от срока",
  expire_term: "истекла: клиент не ответил на срок",
  propose_time: "предложили другое время",
  mark_no_show: "отметили неявку",
  expire_visit: "истекла: запись не разобрана",
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

type OrderKindValue = AdminOrder["kind"];

/** The kinds of A-ORD-01 «тип» and their words (TASK-039). */
export const ORDER_KINDS: readonly OrderKindValue[] = ["stock", "on_order", "service"];

export const ORDER_KIND_TEXT: Record<OrderKindValue, string> = {
  stock: "В наличии",
  on_order: "Под заказ",
  // TASK-038.
  service: "Услуга",
};

/** The filters of A-ORD-01 kept in the address, for the server. */
export function orderFiltersOf(query: URLSearchParams): Omit<AdminOrderListQuery, "limit"> {
  const status = query.get("status");
  const value = (name: string) => query.get(name)?.trim() || undefined;
  return {
    q: value("q"),
    status: ORDER_STATUSES.includes(status as OrderStatusValue)
      ? (status as OrderStatusValue)
      : undefined,
    // A-ORD-01 «тип» (TASK-039).
    kind: ORDER_KINDS.includes(query.get("kind") as OrderKindValue)
      ? (query.get("kind") as OrderKindValue)
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
