import { isApiError } from "@adclub/api-client";
import type { SupplierOrder } from "@adclub/contracts";
import {
  Banner,
  Button,
  DelayedSkeleton,
  EmptyState,
  FadeSwap,
  Icon,
  IconButton,
  ScreenError,
  SkeletonList,
  toastObstacle,
  useLoadingGate,
  useToast,
} from "@adclub/ui";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { apiClient } from "../api";
import { refreshCompany } from "../cabinet/cabinet-store";
import { formatPhone, useOnline } from "@adclub/web-session";
import { useLanguage, useT } from "../i18n";
import { goBack, navigate, useRouteId } from "../router";
import { DeclineDialog } from "./DeclineDialog";
import { TermDialog } from "./TermDialog";
import { useNow, useVisiblePoll } from "./live";
import {
  AnswerTimer,
  FulfillmentLabel,
  Money,
  OrderMarks,
  OrderStatus,
  WorkDeadline,
  actionLabel,
  useAt,
  useWhen,
} from "./OrderParts";
import {
  SETTLE_MS,
  actionProblem,
  changeNotice,
  declineReasonKey,
  formatDate,
  journalLines,
  orderActions,
  termWords,
  whatsappLink,
  type OrderAction,
} from "./order-rules";

/** The card re-reads itself this often while visible: a colleague's answer shows without a press. */
const CARD_POLL_MS = 20_000;

/** Going to the scanner needs no network (it says T-SCAN-01 itself); a move does. */
function needsNetwork(action: OrderAction): boolean {
  return action !== "giveOut" && action !== "closeLate";
}

type Loaded =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "failed"; error: unknown }
  | { status: "ready"; order: SupplierOrder };

/** S-ORD-02 at `/orders/<id>` — the address of the W-01 link, kept over a reload. */
export function OrderCardScreen({ timeZone, blocked }: { timeZone: string; blocked: boolean }) {
  const id = useRouteId();
  return id ? <OrderCard key={id} id={id} timeZone={timeZone} blocked={blocked} /> : null;
}

function OrderCard({ id, timeZone, blocked }: { id: string; timeZone: string; blocked: boolean }) {
  const t = useT();
  const gate = useLoadingGate();
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const { begin, settle } = gate;

  const fetchOrder = async () => {
    const ticket = begin();
    try {
      const { order } = await apiClient.getSupplierOrder({ orderId: id });
      settle(ticket, () => setLoaded({ status: "ready", order }));
    } catch (error) {
      settle(ticket, () =>
        setLoaded(
          // Another company's order answers like a missing one (404).
          isApiError(error) && error.code === "NOT_FOUND"
            ? { status: "missing" }
            : { status: "failed", error },
        ),
      );
    }
  };

  useEffect(() => {
    void fetchOrder();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  let body: ReactNode;
  switch (loaded.status) {
    case "loading":
      body = (
        <>
          <BackHead title={t("orders.cardTitle")} />
          <DelayedSkeleton indicator={gate.indicator}>
            <SkeletonList rows={3} label={t("common.loading")} />
          </DelayedSkeleton>
        </>
      );
      break;
    case "missing":
      body = (
        <>
          <BackHead title={t("orders.cardTitle")} />
          <EmptyState
            icon="search"
            title={t("orders.notFound")}
            text={t("orders.notFoundText")}
            action={
              <Button variant="secondary" onClick={() => navigate("orders", { replace: true })}>
                {t("orders.toList")}
              </Button>
            }
          />
        </>
      );
      break;
    case "failed":
      body = (
        <>
          <BackHead title={t("orders.cardTitle")} />
          <ScreenError
            title={t("common.errorTitle")}
            text={t("common.errorText")}
            retry={{ label: t("common.retry"), onRetry: fetchOrder }}
          />
        </>
      );
      break;
    default:
      body = (
        <OrderView
          order={loaded.order}
          timeZone={timeZone}
          blocked={blocked}
          onOrder={(order) => setLoaded({ status: "ready", order })}
          onMissing={() => setLoaded({ status: "missing" })}
        />
      );
  }
  return (
    <FadeSwap className="page-part" fadeKey={loaded.status}>
      {body}
    </FadeSwap>
  );
}

function BackHead({ title }: { title: string }) {
  const t = useT();
  return (
    <div className="page__head page__head--back">
      <IconButton icon="arrowLeft" label={t("common.back")} onClick={() => goBack("orders")} />
      <h1 className="ac-text-title page__title">{title}</h1>
    </div>
  );
}

function OrderView({
  order,
  timeZone,
  blocked,
  onOrder,
  onMissing,
}: {
  order: SupplierOrder;
  timeZone: string;
  blocked: boolean;
  onOrder: (order: SupplierOrder) => void;
  onMissing: () => void;
}) {
  const t = useT();
  const { lang } = useLanguage();
  const toast = useToast();
  const online = useOnline();
  const now = useNow();
  const when = useWhen(timeZone);
  const at = useAt(timeZone);
  const [notice, setNotice] = useState<{ conflict: boolean; text: string } | null>(null);
  const [declining, setDeclining] = useState(false);
  const [proposing, setProposing] = useState(false);
  /**
   * «Подтвердить срок до {дата}» (S-ORD-02, TASK-039): the date the agreed
   * term gives if confirmed now — the server's (`…/term-options`); until it
   * comes, the button says «Подтвердить срок».
   */
  const [confirmOn, setConfirmOn] = useState<string | null>(null);
  /** The order just changed under the employee's finger: the buttons wait a moment. */
  const [held, setHeld] = useState(false);
  const busy = useRef(false);

  useEffect(() => {
    if (!held) return;
    const timer = setTimeout(() => setHeld(false), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [held]);

  /**
   * The order as it is now; quietly, without an indicator (a poll, after a
   * conflict). Moved by someone else meanwhile — the card says who, and its
   * buttons (now other ones, in the same places) wait a moment.
   */
  const reread = async (options: { tell?: boolean } = {}) => {
    try {
      const { order: current } = await apiClient.getSupplierOrder({ orderId: order.id });
      const changed = changeNotice(order, current, at, t);
      if (changed) {
        setHeld(true);
        if (options.tell !== false) setNotice({ conflict: true, text: changed });
      }
      onOrder(current);
    } catch (error) {
      if (isApiError(error) && error.code === "NOT_FOUND") onMissing();
    }
  };

  useEffect(() => {
    if (order.kind !== "on_order" || order.status !== "created") return;
    let live = true;
    apiClient
      .getSupplierOrderTermOptions({ orderId: order.id })
      .then((answer) => {
        if (live) setConfirmOn(answer.confirm.readyOn);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [order.id, order.kind, order.status]);

  useVisiblePoll(() => {
    if (!busy.current) void reread();
  }, CARD_POLL_MS);

  // The answer deadline passes while the card is open: read it again — the
  // server expires the order on reading, and «Принять» goes away with it.
  const deadline = order.status === "created" ? Date.parse(order.respondBy) : null;
  const expiredHere = deadline !== null && now >= deadline;
  useEffect(() => {
    if (!expiredHere) return;
    const timer = setTimeout(() => void reread());
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expiredHere]);

  const move = async (action: "accept" | "markReady") => {
    busy.current = true;
    setNotice(null);
    try {
      const call =
        action === "accept" ? apiClient.acceptSupplierOrder : apiClient.markSupplierOrderReady;
      const { order: moved } = await call(
        { orderId: order.id },
        { expectedVersion: order.version },
      );
      onOrder(moved);
      toast.show(
        t(action === "accept" ? "orders.acceptedToast" : "orders.readyToast", {
          number: order.number,
        }),
      );
    } catch (thrown) {
      const problem = actionProblem(thrown, at, t);
      setNotice(problem);
      if (problem.companyChanged) void refreshCompany();
      if (problem.conflict) await reread({ tell: false });
    } finally {
      busy.current = false;
    }
  };

  const press = (action: OrderAction) => {
    switch (action) {
      case "accept":
      case "markReady":
        return move(action);
      case "decline":
        setDeclining(true);
        return undefined;
      case "proposeTerm":
        setProposing(true);
        return undefined;
      case "giveOut":
        navigate("scan");
        return undefined;
      case "closeLate":
        navigate("scan", { state: { manual: true } });
        return undefined;
    }
  };

  const actions = orderActions(order, now, { blocked });
  const label = (action: OrderAction) =>
    action === "accept" && order.kind === "on_order" && confirmOn
      ? t("orders.confirmTermUntil", { date: formatDate(confirmOn, lang) })
      : t(actionLabel(action, order.kind));
  const day = (date: string) => formatDate(date, lang);
  const journal = journalLines(order.events, when, t, day, order.kind);
  const term = termWords(order, day, when, t);
  const priceChanged =
    order.currentOfferPrice !== null && order.currentOfferPrice !== order.unitPrice;

  return (
    <>
      <BackHead title={t("orders.number", { number: order.number })} />

      <div className="order-head">
        <OrderStatus order={order} />
        {order.status === "created" ? (
          <AnswerTimer respondBy={order.respondBy} />
        ) : (
          <WorkDeadline order={order} when={when} />
        )}
        <OrderMarks order={order} />
      </div>

      {notice && (
        <Banner
          tone={notice.conflict ? "neutral" : "danger"}
          icon={notice.conflict ? "info" : undefined}
        >
          {notice.text}
        </Banner>
      )}
      {blocked && (actions.primary !== null || actions.secondary.length > 0) && (
        <Banner tone="warning">{t("orders.blockedNote")}</Banner>
      )}

      <section className="card" aria-labelledby="order-customer">
        <h2 id="order-customer" className="ac-text-heading">
          {t("orders.customer")}
        </h2>
        {order.customer.kind === "hidden" ? (
          <p className="order-hidden">
            <Icon name="lock" size={20} />
            <span>{t("orders.customerHidden")}</span>
          </p>
        ) : (
          <div className="stack-s">
            <p className="ac-text-body-strong">
              {order.customer.name ?? t("orders.customerNoName")}
            </p>
            <p className="num">{formatPhone(order.customer.phone)}</p>
            <div className="actions-row">
              <a
                className="ac-button ac-button--secondary ac-button--m"
                href={`tel:${order.customer.phone}`}
              >
                <Icon name="phone" size={20} />
                <span>{t("orders.call")}</span>
              </a>
              <a
                className="ac-button ac-button--secondary ac-button--m"
                href={whatsappLink(order.customer.phone)}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Icon name="whatsapp" size={20} />
                <span>{t("orders.whatsapp")}</span>
              </a>
            </div>
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="order-item">
        <h2 id="order-item" className="ac-text-heading">
          {t("orders.item")}
        </h2>
        <div className="item-block">
          <span className="item-block__thumb" aria-hidden="true">
            {order.item.photo ? (
              <img src={order.item.photo.thumbUrl} alt="" />
            ) : (
              <Icon name="package" size={24} />
            )}
          </span>
          <div className="item-block__text">
            <p className="ac-text-body-strong item-block__name">{order.item.name.text}</p>
            {(order.item.brand || order.item.article) && (
              <p className="ac-text-body-s ac-muted">
                {[order.item.brand, order.item.article].filter(Boolean).join(" · ")}
              </p>
            )}
          </div>
        </div>
        <dl className="facts">
          <div>
            <dt>{t("orders.quantity")}</dt>
            <dd className="num">{order.quantity}</dd>
          </div>
          <div>
            <dt>{t("orders.priceByOrder")}</dt>
            <dd>
              <Money value={order.unitPrice} />
              {priceChanged && <span className="facts__note">{t("orders.priceFixed")}</span>}
            </dd>
          </div>
          <div>
            <dt>{t("orders.total")}</dt>
            <dd className="ac-text-body-strong">
              <Money value={order.total} />
            </dd>
          </div>
          <div>
            <dt>{t("orders.receiving")}</dt>
            <dd>
              <FulfillmentLabel fulfillment={order.fulfillment} />
              {order.receiptOn && (
                <span className="facts__note">
                  {t("orders.receiptOn", { date: formatDate(order.receiptOn, lang) })}
                </span>
              )}
            </dd>
          </div>
          {term && (
            <div>
              <dt>{t("orders.term")}</dt>
              <dd>
                {term.text}
                {term.note && <span className="facts__note">{term.note}</span>}
              </dd>
            </div>
          )}
        </dl>
        {order.comment && (
          <p className="ac-text-body-s">
            <span className="ac-muted">{t("orders.comment")}: </span>
            {order.comment}
          </p>
        )}
        {order.decline && (order.decline.reason || order.decline.note) && (
          <p className="ac-text-body-s">
            <span className="ac-muted">{t("orders.declineReason")}: </span>
            {[order.decline.reason && t(declineReasonKey(order.decline.reason)), order.decline.note]
              .filter(Boolean)
              .join(" · ")}
          </p>
        )}
      </section>

      {journal.length > 0 && (
        <section className="card" aria-labelledby="order-journal">
          <h2 id="order-journal" className="ac-text-heading">
            {t("orders.journal")}
          </h2>
          <ol className="journal">
            {journal.map((line) => (
              <li key={line.id} className="ac-text-body-s">
                {line.text}
              </li>
            ))}
          </ol>
        </section>
      )}

      {(actions.primary || actions.secondary.length > 0) && (
        <div className="save-bar order-actions" {...toastObstacle}>
          {actions.secondary.map((action) => (
            <Button
              key={action}
              variant="secondary"
              destructive={action === "decline"}
              disabled={held || (!online && needsNetwork(action))}
              onClick={() => press(action)}
            >
              {label(action)}
            </Button>
          ))}
          {actions.primary && (
            <Button
              disabled={held || (!online && needsNetwork(actions.primary))}
              onClick={() => press(actions.primary!)}
            >
              {label(actions.primary)}
            </Button>
          )}
          {!online && needsNetwork(actions.primary ?? actions.secondary[0]!) && (
            <span className="ac-text-caption ac-muted">{t("common.needNetwork")}</span>
          )}
        </div>
      )}

      <TermDialog
        target={proposing ? { id: order.id, number: order.number, version: order.version } : null}
        format={when}
        onClose={() => setProposing(false)}
        onProposed={(proposed) => onOrder(proposed)}
        onProblem={(problem) => {
          setNotice(problem);
          void reread({ tell: false });
        }}
      />

      <DeclineDialog
        target={declining ? { id: order.id, number: order.number, version: order.version } : null}
        format={at}
        onClose={() => setDeclining(false)}
        onDeclined={(declined) => onOrder(declined)}
        onProblem={(problem) => {
          setNotice(problem);
          void reread({ tell: false });
        }}
      />
    </>
  );
}
