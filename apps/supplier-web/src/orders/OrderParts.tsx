import type { OrderFulfillment, OrderKind, SupplierOrderSummary } from "@adclub/contracts";
import { Badge, Button, Icon, StatusBadge } from "@adclub/ui";
import { useCallback, type MouseEvent } from "react";
import { useLanguage, useT } from "../i18n";
import { formatAmount } from "../offers/offer-rules";
import { navigateTo, orderPath } from "../router";
import { useNow } from "./live";
import {
  answerTimer,
  durationText,
  formatAt,
  formatWhen,
  orderActions,
  statusGroup,
  statusKey,
  supplyOverdue,
  type OrderAction,
} from "./order-rules";

/** Times in the zone of the company's point, said as short as they can be. */
export function useWhen(timeZone: string): (iso: string) => string {
  const { lang, t } = useLanguage();
  return useCallback((iso: string) => formatWhen(iso, timeZone, lang, t), [timeZone, lang, t]);
}

/** The same times inside a sentence: «в 14:02», «вчера в 14:02», «12 октября в 14:02». */
export function useAt(timeZone: string): (iso: string) => string {
  const { lang, t } = useLanguage();
  return useCallback((iso: string) => formatAt(iso, timeZone, lang, t), [timeZone, lang, t]);
}

/** «12 500 ₸» */
export function Money({ value }: { value: number }) {
  return <span className="num">{formatAmount(value)} ₸</span>;
}

/**
 * «Ответить за 12 мин» — live, from the one clock of the page; under 15
 * minutes in `warning` with an icon, not by colour alone (S-ORD-01).
 */
export function AnswerTimer({ respondBy }: { respondBy: string }) {
  const t = useT();
  const now = useNow();
  const timer = answerTimer(respondBy, now);
  if (timer.kind === "expired") {
    return (
      <span className="timer timer--expired">
        <Icon name="clock" size={16} />
        {t("orders.answerExpired")}
      </span>
    );
  }
  return (
    <span className={timer.urgent ? "timer timer--urgent" : "timer"}>
      <Icon name={timer.urgent ? "alertTriangle" : "clock"} size={16} />
      {t("orders.answerIn", { time: durationText(timer.minutes, t) })}
    </span>
  );
}

export function OrderStatus({ order }: { order: Pick<SupplierOrderSummary, "status" | "kind"> }) {
  const t = useT();
  return (
    <StatusBadge group={statusGroup(order.status)}>
      {t(statusKey(order.status, order.kind))}
    </StatusBadge>
  );
}

export function FulfillmentLabel({ fulfillment }: { fulfillment: OrderFulfillment }) {
  const t = useT();
  return (
    <span className="receiving">
      <Icon name={fulfillment === "pickup" ? "store" : "truck"} size={16} />
      {t(fulfillment === "pickup" ? "orders.pickup" : "orders.delivery")}
    </span>
  );
}

/**
 * «Под заказ» and «Срок поставки прошёл» (S-ORD-01, TASK-039), «Тестовый»,
 * «Закрыта администратором», «Закрыта после срока».
 */
export function OrderMarks({
  order,
}: {
  order: Pick<SupplierOrderSummary, "isTest" | "closure" | "kind" | "status" | "onOrderTerm">;
}) {
  const t = useT();
  return (
    <>
      {order.kind === "on_order" && (
        <Badge tone="neutral" icon="package">
          {t("orders.mark.onOrder")}
        </Badge>
      )}
      {supplyOverdue(order) && (
        <Badge tone="warning" icon="alertTriangle">
          {t("orders.mark.supplyOverdue")}
        </Badge>
      )}
      {order.isTest && (
        <Badge tone="neutral" icon="info">
          {t("orders.mark.test")}
        </Badge>
      )}
      {order.closure?.method === "admin" && (
        <Badge tone="neutral" icon="lock">
          {t("orders.mark.closedByAdmin")}
        </Badge>
      )}
      {order.closure?.late && order.closure.method !== "admin" && (
        <Badge tone="neutral" icon="clock">
          {t("orders.mark.closedLate")}
        </Badge>
      )}
    </>
  );
}

/**
 * The deadline line of an order in progress: «Резерв до 18:00», «Срок
 * истёк — можно закрыть до 14:00» (S-ORD-01 «В работе»).
 */
export function WorkDeadline({
  order,
  when,
}: {
  order: SupplierOrderSummary;
  when: (iso: string) => string;
}) {
  const t = useT();
  if (order.status === "reserve_expired" && order.lateCloseUntil) {
    return (
      <span className="timer timer--urgent">
        <Icon name="alertTriangle" size={16} />
        {t("orders.lateCloseUntil", { time: when(order.lateCloseUntil) })}
      </span>
    );
  }
  if ((order.status === "accepted" || order.status === "ready") && order.reserveUntil) {
    return (
      <span className="timer">
        <Icon name="clock" size={16} />
        {t("orders.reserveUntil", { time: when(order.reserveUntil) })}
      </span>
    );
  }
  // TASK-037: the customer is to answer another term by then.
  if (order.status === "term_proposed" && order.onOrderTerm?.proposed) {
    return (
      <span className="timer">
        <Icon name="clock" size={16} />
        {t("orders.customerAnswersBy", { time: when(order.onOrderTerm.proposed.answerBy) })}
      </span>
    );
  }
  return null;
}

const actionKeys = {
  accept: "orders.accept",
  decline: "orders.decline",
  markReady: "orders.markReady",
  giveOut: "orders.giveOut",
  closeLate: "orders.closeLate",
  proposeTerm: "orders.proposeTerm",
} as const;

/** The word of a button; «Принять» of an order under order is «Подтвердить срок» (TASK-037). */
export function actionLabel(
  action: OrderAction,
  kind?: OrderKind,
): (typeof actionKeys)[OrderAction] | "orders.confirmTerm" {
  return action === "accept" && kind === "on_order" ? "orders.confirmTerm" : actionKeys[action];
}

/** Opens the card of an order in the cabinet (`/orders/<id>`), a modifier click — in a new tab. */
export function openOrder(event: MouseEvent<HTMLAnchorElement>, id: string): void {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
    return;
  }
  event.preventDefault();
  navigateTo(orderPath(id));
}

/** The quick «Принять» / «Отказать» of a new order in the list (S-ORD-01). */
export function QuickActions({
  order,
  blocked,
  online,
  onAccept,
  onDecline,
  compact = false,
}: {
  order: SupplierOrderSummary;
  blocked: boolean;
  online: boolean;
  onAccept: () => Promise<unknown>;
  onDecline: () => void;
  compact?: boolean;
}) {
  const t = useT();
  const now = useNow();
  const actions = orderActions(order, now, { blocked });
  if (actions.primary !== "accept") return null;
  const size = compact ? "s" : "m";
  return (
    <div className="order-card__actions">
      <Button variant="secondary" size={size} disabled={!online} onClick={onDecline}>
        {t("orders.decline")}
      </Button>
      <Button size={size} disabled={!online} onClick={onAccept}>
        {t(actionLabel("accept", order.kind))}
      </Button>
    </div>
  );
}
