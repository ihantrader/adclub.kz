import type {
  AdminSignal,
  AdminSignalActor,
  AdminSignalKind,
  AdminSignalStatus,
} from "@adclub/contracts";
import { orderExtensionsPath, orderPath, supplierPath } from "../router";

/**
 * The words of A-HOME and A-SIG (TASK-034 requirement 3): what a signal is
 * about and who acted on it. The server decides everything; these only say it.
 */
export const KIND_TITLES: Record<AdminSignalKind, string> = {
  whatsapp_outage: "Сбой канала уведомлений",
  duplicate_after_late_close: "Двойная заявка при позднем закрытии",
  frequent_admin_closes: "Частые закрытия администратором",
  supplier_unreachable: "Поставщик недостижим",
  supply_overdue: "Срок поставки прошёл",
};

/** The kinds in the order of importance of A-HOME. */
export const KIND_ORDER: readonly AdminSignalKind[] = [
  "whatsapp_outage",
  "supplier_unreachable",
  "supply_overdue",
  "duplicate_after_late_close",
  "frequent_admin_closes",
];

export const STATUS_TEXT: Record<AdminSignalStatus, string> = {
  open: "Новый",
  acknowledged: "В работе",
  closed: "Закрыт",
};

function plural(n: number, one: string, few: string, many: string): string {
  const last = n % 10;
  const lastTwo = n % 100;
  if (last === 1 && lastTwo !== 11) return one;
  if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) return few;
  return many;
}

export function count(n: number, one: string, few: string, many: string): string {
  return `${n.toLocaleString("ru-RU")} ${plural(n, one, few, many)}`;
}

/** What the signal is about, in one line («Заявки № 1001 и № 1004»). */
export function subjectText(signal: Pick<AdminSignal, "kind" | "payload">): string {
  const { payload } = signal;
  switch (signal.kind) {
    case "whatsapp_outage":
      return [
        payload.affectedOrders !== undefined
          ? count(payload.affectedOrders, "заявка", "заявки", "заявок")
          : null,
        payload.failedMessages !== undefined
          ? `не дошло ${count(payload.failedMessages, "уведомление", "уведомления", "уведомлений")}`
          : null,
      ]
        .filter(Boolean)
        .join(", ");
    case "duplicate_after_late_close":
      return [
        payload.orderNumber !== undefined ? `№ ${payload.orderNumber}` : null,
        payload.otherOrderNumber !== undefined ? `№ ${payload.otherOrderNumber}` : null,
      ]
        .filter(Boolean)
        .join(" и ");
    case "frequent_admin_closes":
      return [
        payload.supplierName,
        payload.closes !== undefined && payload.days !== undefined
          ? `${count(payload.closes, "закрытие", "закрытия", "закрытий")} за ${count(payload.days, "день", "дня", "дней")}`
          : null,
      ]
        .filter(Boolean)
        .join(" · ");
    case "supplier_unreachable":
      return [
        payload.supplierName,
        payload.recipients !== undefined
          ? `без WhatsApp ${payload.recipientsWithoutWhatsapp ?? 0} из ${count(payload.recipients, "получателя", "получателей", "получателей")}`
          : null,
      ]
        .filter(Boolean)
        .join(" · ");
    case "supply_overdue":
      return [
        payload.orderNumber !== undefined ? `№ ${payload.orderNumber}` : null,
        payload.supplierName,
        payload.readyOn ? `обещано на ${payload.readyOn.split("-").reverse().join(".")}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
  }
}

/**
 * «Открыть объект» (A-SIG): where the subject of a signal opens — an order
 * its card (TASK-036.B: «Двойная заявка при позднем закрытии»); a supplier
 * with frequent closes without a code — its orders, an unreachable one —
 * «Сотрудники» (who receives the notifications, TASK-036); the channel's
 * outage — the orders to extend (A-ORD-03) from when it began.
 */
export function subjectLink(
  signal: Pick<AdminSignal, "subjectType" | "subjectId"> &
    Partial<Pick<AdminSignal, "kind" | "payload">>,
): string | null {
  switch (signal.subjectType) {
    case "order":
      return orderPath(signal.subjectId);
    case "supplier":
      return supplierPath(
        signal.subjectId,
        signal.kind === "frequent_admin_closes" ? "orders" : "members",
      );
    case "channel":
      return signal.kind === "whatsapp_outage"
        ? orderExtensionsPath(signal.payload?.since ?? undefined)
        : null;
  }
}

/** What the administrator does about it — the hint under a card or a row. */
export const KIND_HINTS: Record<AdminSignalKind, string> = {
  whatsapp_outage:
    "Уведомления поставщикам о заявках не доходят. Сроки заявок не меняются сами — продлите их вручную.",
  duplicate_after_late_close:
    "Поставщик выдал просроченную заявку, а клиент тем временем оформил такую же. Проверьте, не выдан ли товар дважды.",
  frequent_admin_closes:
    "У поставщика часто закрывают заявки без кода. Проверьте, пользуется ли он сканером и настоящие ли заявки.",
  supplier_unreachable:
    "У всех, кто получает уведомления компании, нет WhatsApp — заявки до неё не доходят. Свяжитесь с поставщиком.",
  supply_overdue:
    "Подтверждённый срок поставки под заказ прошёл, а заявка ещё не готова к выдаче. Свяжитесь с поставщиком.",
};

/** Who acted: the administrator's name or number, or the server itself. */
export function actorName(actor: AdminSignalActor | null): string {
  if (!actor) return "";
  if (actor.kind === "system") return "система (событие закончилось)";
  return actor.name ?? actor.phoneMasked ?? "администратор";
}

/** «Уже закрыт {кем}» and its kin: what changed under the administrator's action. */
export function conflictText(signal: AdminSignal): string {
  if (signal.status === "closed") {
    return `Сигнал уже закрыт: ${actorName(signal.closedBy)}. Обновите страницу`;
  }
  if (signal.status === "acknowledged") {
    return `Сигнал уже взят в работу: ${actorName(signal.acknowledgedBy)}`;
  }
  return "Эти данные только что изменили. Обновите страницу";
}
