import type { OrderFulfillment, OrderKind, SupplierOrderSummary } from "@adclub/contracts";
import { orderStatusGroups, type IconName } from "@adclub/ui-core";
import { ActionBar, Badge, Button, Icon, StatusBadge, TypeMark } from "@adclub/ui";
import { useCallback, type MouseEvent } from "react";
import { useLanguage, useT } from "../i18n";
import { formatAmount, TENGE } from "../offers/offer-rules";
import { navigateTo, orderPath } from "../router";
import { useNow } from "./live";
import {
  answerTimer,
  durationText,
  formatAt,
  formatDate,
  formatWhen,
  orderActions,
  statusGroup,
  statusKey,
  supplyOverdue,
  visitWords,
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
  return <span className="num">{`${formatAmount(value)}${TENGE}`}</span>;
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

/**
 * The icon of a finished order says how it ended (TASK-079): given out —
 * a check, cancelled or declined — a cross, ran out of time — a clock;
 * the colour stays the group's (DESIGN 7.8). Orders in progress keep the
 * icon of their group.
 */
function outcomeIcon(status: SupplierOrderSummary["status"]): IconName | null {
  switch (status) {
    case "completed":
      return "circleCheck";
    case "cancelled_by_user":
    case "cancelled_by_admin":
    case "declined_by_supplier":
    case "no_show":
      return "circleX";
    case "response_expired":
    case "reserve_expired":
    case "term_expired":
    case "visit_unresolved":
      return "clock";
    default:
      return null;
  }
}

export function OrderStatus({ order }: { order: Pick<SupplierOrderSummary, "status" | "kind"> }) {
  const t = useT();
  const group = statusGroup(order.status);
  const icon = outcomeIcon(order.status);
  const text = t(statusKey(order.status, order.kind));
  return icon ? (
    <Badge tone={orderStatusGroups[group].tone} icon={icon}>
      {text}
    </Badge>
  ) : (
    <StatusBadge group={group}>{text}</StatusBadge>
  );
}

/**
 * The status as the heading of the order card (S-ORD-02, DESIGN 7.4:
 * `title` «статус заявки»): the word, with the icon of its group in the
 * group's colour — the meaning is never the colour alone.
 */
export function OrderHeadline({ order }: { order: Pick<SupplierOrderSummary, "status" | "kind"> }) {
  const t = useT();
  const group = statusGroup(order.status);
  const { tone, icon } = orderStatusGroups[group];
  return (
    <h2 className={`ac-text-title order-headline order-headline--${tone}`}>
      <Icon name={outcomeIcon(order.status) ?? icon} size={24} />
      <span>{t(statusKey(order.status, order.kind))}</span>
    </h2>
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
 * How the order is received: pickup or delivery; a service (TASK-038) — the
 * car and the time of the visit instead (S-ORD-01 «тип», S-ORD-02).
 */
export function OrderReceiving({
  order,
  when,
}: {
  order: Pick<SupplierOrderSummary, "fulfillment" | "status" | "serviceVisit">;
  when: (iso: string) => string;
}) {
  const t = useT();
  const visit = visitWords(order, when, t);
  if (!visit) return <FulfillmentLabel fulfillment={order.fulfillment} />;
  return (
    <span className="receiving">
      <Icon name="car" size={16} />
      {visit.car} · {visit.time}
    </span>
  );
}

/**
 * «Под заказ» and «Срок поставки прошёл» (S-ORD-01, TASK-039), «Услуга» (TASK-038), «Тестовый»,
 * «Закрыта администратором», «Закрыта после срока».
 */
export function OrderMarks({
  order,
  withKind = true,
}: {
  order: Pick<SupplierOrderSummary, "isTest" | "closure" | "kind" | "status" | "onOrderTerm">;
  /**
   * `false` — the table: the kind has a column of its own, and an overdue
   * supply is said by the deadline in the «Срок и статус» column.
   */
  withKind?: boolean;
}) {
  const t = useT();
  // Kinds and properties are quiet marks, not badges (C11); only a problem is a badge.
  return (
    <>
      {withKind && <OrderKindMark kind={order.kind} />}
      {withKind && supplyOverdue(order) && (
        <Badge tone="warning" icon="alertTriangle">
          {t("orders.mark.supplyOverdue")}
        </Badge>
      )}
      {order.isTest && <TypeMark icon="info">{t("orders.mark.test")}</TypeMark>}
      {order.closure?.method === "admin" && (
        <TypeMark icon="lock">{t("orders.mark.closedByAdmin")}</TypeMark>
      )}
      {order.closure?.late && order.closure.method !== "admin" && (
        <TypeMark icon="clock">{t("orders.mark.closedLate")}</TypeMark>
      )}
    </>
  );
}

/** «Под заказ», «Услуга» — the kind of an order; one in stock says nothing unless asked (`stock`). */
export function OrderKindMark({ kind, stock = false }: { kind: OrderKind; stock?: boolean }) {
  const t = useT();
  if (kind === "on_order") return <TypeMark icon="clock">{t("orders.mark.onOrder")}</TypeMark>;
  if (kind === "service") return <TypeMark icon="wrench">{t("orders.mark.service")}</TypeMark>;
  return stock ? <TypeMark icon="package">{t("orders.mark.inStock")}</TypeMark> : null;
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
  const { lang } = useLanguage();
  if (
    (order.status === "reserve_expired" || order.status === "visit_unresolved") &&
    order.lateCloseUntil
  ) {
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
  // TASK-037, TASK-038: the customer is to answer another term or time by then.
  const proposed = order.onOrderTerm?.proposed ?? order.serviceVisit?.proposed;
  if (order.status === "term_proposed" && proposed) {
    return (
      <span className="timer">
        <Icon name="clock" size={16} />
        {t("orders.customerAnswersBy", { time: when(proposed.answerBy) })}
      </span>
    );
  }
  // TASK-038: a confirmed visit — its time.
  if (order.status === "accepted" && order.serviceVisit?.confirmed) {
    return (
      <span className="timer">
        <Icon name="clock" size={16} />
        {t("orders.visitAt", { time: when(order.serviceVisit.confirmed.visitAt) })}
      </span>
    );
  }
  // An order under order with its term confirmed: by when to bring it (TASK-079);
  // past it — `warning`, with its icon.
  const confirmedOn = order.onOrderTerm?.confirmed?.readyOn;
  if (order.status === "accepted" && confirmedOn) {
    const overdue = supplyOverdue(order);
    return (
      <span className={overdue ? "timer timer--urgent" : "timer"}>
        <Icon name={overdue ? "alertTriangle" : "clock"} size={16} />
        {t("orders.bringBy", { date: formatDate(confirmedOn, lang) })}
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
  proposeTime: "orders.proposeTime",
  noShow: "orders.noShow.action",
} as const;

/**
 * The word of a button; «Принять» of an order under order is «Подтвердить
 * срок» (TASK-037), of a service — «Подтвердить время», and its «Выдать» is
 * «Отметить выполнение» (TASK-038; S-ORD-02).
 */
export function actionLabel(
  action: OrderAction,
  kind?: OrderKind,
):
  | (typeof actionKeys)[OrderAction]
  | "orders.confirmTerm"
  | "orders.confirmTime"
  | "orders.markDone" {
  if (kind === "service" && action === "accept") return "orders.confirmTime";
  if (kind === "service" && action === "giveOut") return "orders.markDone";
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
  // In a list every row has them: secondary, never the screen's main button (C15).
  const accept = (
    <Button
      key="accept"
      variant="secondary"
      size={compact ? "s" : "m"}
      disabled={!online}
      onClick={onAccept}
    >
      {t(actionLabel("accept", order.kind))}
    </Button>
  );
  const decline = (
    <Button
      key="decline"
      variant="secondary"
      destructive
      size={compact ? "s" : "m"}
      disabled={!online}
      onClick={onDecline}
    >
      {t("orders.decline")}
    </Button>
  );
  if (compact) {
    return (
      <div className="order-card__actions">
        {decline}
        {accept}
      </div>
    );
  }
  return (
    <ActionBar
      compact
      className="order-card__actions"
      label={t("orders.actionsLabel")}
      others={[accept, decline]}
    />
  );
}
