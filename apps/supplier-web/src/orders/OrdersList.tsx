import type {
  SupplierFinishedStatus,
  SupplierOrderPage,
  SupplierOrderSummary,
} from "@adclub/contracts";
import {
  Banner,
  Button,
  Chip,
  EmptyState,
  LoadingContent,
  ScreenError,
  Segments,
  SkeletonList,
  useLoadingGate,
  useToast,
} from "@adclub/ui";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { apiClient } from "../api";
import { useOnline } from "../connection";
import { useT } from "../i18n";
import { useWide } from "../offers/use-wide";
import { navigateTo, orderPath, replaceRouteState, useRouteState } from "../router";
import { DeclineDialog, type DeclineTarget } from "./DeclineDialog";
import { reportNewOrders, useVisiblePoll } from "./live";
import {
  AnswerTimer,
  FulfillmentLabel,
  Money,
  OrderMarks,
  OrderStatus,
  QuickActions,
  WorkDeadline,
  openOrder,
  useWhen,
} from "./OrderParts";
import {
  ALL_FINISHED,
  SETTLE_MS,
  actionProblem,
  arrivedIds,
  finishedQuery,
  workGroups,
  type FinishedFilter,
  type FinishedPeriod,
  type WorkGroup,
} from "./order-rules";

type Tab = "new" | "in_progress" | "finished";

interface ListQuery {
  tab: Tab;
  finished: FinishedFilter;
}

const EMPTY_QUERY: ListQuery = { tab: "new", finished: ALL_FINISHED };

function queryOf(state: unknown): ListQuery {
  const value = (state as { list?: Partial<ListQuery> } | null)?.list;
  return value ? { ...EMPTY_QUERY, ...value } : EMPTY_QUERY;
}

interface Shown {
  query: ListQuery;
  orders: SupplierOrderSummary[];
  counts: SupplierOrderPage["counts"];
  nextCursor: string | null;
}

const PAGE = 30;
/** The list re-reads itself this often while the page is visible: a new order shows within it. */
export const ORDERS_POLL_MS = 15_000;
/** How long an order that just came in stays lit up. */
const FRESH_MS = 6_000;

const periods: readonly FinishedPeriod[] = ["today", "week", "month", "all"];
const finishedStatuses: readonly SupplierFinishedStatus[] = [
  "completed",
  "cancelled_by_user",
  "declined_by_supplier",
  "response_expired",
  "reserve_expired",
];

const groupKeys: Record<
  WorkGroup,
  "orders.group.awaitingPickup" | "orders.group.preparing" | "orders.group.lateClose"
> = {
  awaitingPickup: "orders.group.awaitingPickup",
  preparing: "orders.group.preparing",
  lateClose: "orders.group.lateClose",
};

/**
 * S-ORD-01 «Заявки» (TASK-033): «Новые · N» by the answer deadline with
 * live timers and «Принять» / «Отказать» in the row, «В работе» in its
 * groups, «Завершённые» by period and status. While the page is visible
 * the list re-reads itself every `ORDERS_POLL_MS` and as soon as the page
 * comes back on screen — a new order lights up; a hidden tab asks
 * nothing. Loading follows the one rule (D-069): a tab or a filter keeps
 * the list on screen, dimmed under the refresh line, until the new one.
 */
export function OrdersList({
  generation,
  timeZone,
  blocked,
}: {
  generation: number;
  timeZone: string;
  blocked: boolean;
}) {
  const t = useT();
  const wide = useWide();
  const online = useOnline();
  const toast = useToast();
  const when = useWhen(timeZone);
  const opened = useRouteState();
  const gate = useLoadingGate();
  const [query, setQuery] = useState<ListQuery>(() => queryOf(opened));
  const [shown, setShown] = useState<Shown | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<{ conflict: boolean; text: string } | null>(null);
  const [declining, setDeclining] = useState<DeclineTarget | null>(null);
  /** Rows just moved under the finger (a poll): «Принять» in them waits a moment. */
  const [held, setHeld] = useState(false);
  const request = useRef<AbortController | null>(null);
  const shownRef = useRef<Shown | null>(null);
  useEffect(() => {
    shownRef.current = shown;
  }, [shown]);
  const { begin, settle } = gate;

  const queryParams = useCallback(
    (next: ListQuery) => ({
      tab: next.tab,
      ...(next.tab === "finished" && finishedQuery(next.finished, timeZone)),
    }),
    [timeZone],
  );

  /** A tab, a filter, a retry: through the loading rule; only the last one counts. */
  const load = useCallback(
    async (next: ListQuery) => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setLoadingMore(false);
      const ticket = begin();
      try {
        const page = await apiClient.listSupplierOrders({
          query: { ...queryParams(next), limit: PAGE },
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        reportNewOrders(generation, page.counts.new);
        settle(ticket, () => {
          setShown({
            query: next,
            orders: page.orders,
            counts: page.counts,
            nextCursor: page.nextCursor,
          });
          setFailure(null);
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        settle(ticket, () => setFailure(error));
      } finally {
        if (request.current === controller) request.current = null;
      }
    },
    [begin, settle, queryParams, generation],
  );

  /**
   * The poll: the same list again, as many rows as are on screen, quietly —
   * no indicator, nothing dims; orders not seen before light up. Skipped
   * while another list is on its way.
   */
  const refresh = useCallback(async () => {
    const current = shownRef.current;
    if (!current || gate.pending || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    try {
      const page = await apiClient.listSupplierOrders({
        query: {
          ...queryParams(current.query),
          limit: Math.min(100, Math.max(PAGE, current.orders.length)),
        },
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      reportNewOrders(generation, page.counts.new);
      const arrived = arrivedIds(
        new Set(current.orders.map((order) => order.id)),
        page.orders.map((order) => order.id),
      );
      setShown((now) =>
        now && now.query === current.query
          ? { ...now, orders: page.orders, counts: page.counts, nextCursor: page.nextCursor }
          : now,
      );
      if (arrived.length > 0) setFresh((before) => new Set([...before, ...arrived]));
      const before = current.orders.map((order) => order.id).join();
      if (before !== page.orders.map((order) => order.id).join()) setHeld(true);
    } catch {
      // A failed poll changes nothing on screen; the next one tries again.
    } finally {
      if (request.current === controller) request.current = null;
    }
  }, [gate.pending, queryParams, generation]);

  useVisiblePoll(() => void refresh(), ORDERS_POLL_MS, shown !== null);

  useEffect(() => {
    if (!held) return;
    const timer = setTimeout(() => setHeld(false), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [held]);

  // Lit-up orders go back to normal after a moment.
  useEffect(() => {
    if (fresh.size === 0) return;
    const timer = setTimeout(() => setFresh(new Set()), FRESH_MS);
    return () => clearTimeout(timer);
  }, [fresh]);

  useEffect(() => {
    replaceRouteState({ list: query });
    void load(query);
  }, [query, load]);

  useEffect(() => () => request.current?.abort(), []);

  const loadMore = async (list: Shown) => {
    if (!list.nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await apiClient.listSupplierOrders({
        query: { ...queryParams(list.query), limit: PAGE, cursor: list.nextCursor },
      });
      setShown((current) =>
        current && current.query === list.query
          ? {
              ...current,
              orders: [
                ...current.orders,
                ...page.orders.filter((o) => !current.orders.some((c) => c.id === o.id)),
              ],
              counts: page.counts,
              nextCursor: page.nextCursor,
            }
          : current,
      );
    } catch {
      // «Показать ещё» stays to try again.
    } finally {
      setLoadingMore(false);
    }
  };

  const accept = async (order: SupplierOrderSummary) => {
    setNotice(null);
    try {
      await apiClient.acceptSupplierOrder(
        { orderId: order.id },
        { expectedVersion: order.version },
      );
      toast.show(t("orders.acceptedToast", { number: order.number }), {
        action: { label: t("orders.open"), onAction: () => navigateTo(orderPath(order.id)) },
      });
    } catch (thrown) {
      setNotice(actionProblem(thrown, when, t));
    }
    await refresh();
  };

  const counts = shown?.counts ?? null;
  const retry = { label: t("common.retry"), onRetry: () => load(query) };

  return (
    <>
      <div className="page__head">
        <h1 className="ac-text-title page__title">{t("orders.title")}</h1>
      </div>

      <div className="offers-controls">
        <Segments<Tab>
          label={t("orders.title")}
          value={query.tab}
          onChange={(tab) => {
            setNotice(null);
            setQuery((current) => ({ ...current, tab }));
          }}
          options={[
            {
              value: "new",
              label: counts ? `${t("orders.tabNew")} · ${counts.new}` : t("orders.tabNew"),
            },
            { value: "in_progress", label: t("orders.tabInProgress") },
            { value: "finished", label: t("orders.tabFinished") },
          ]}
        />
        {query.tab === "finished" && (
          <>
            <div className="chips" role="group" aria-label={t("orders.filterPeriod")}>
              {periods.map((period) => (
                <Chip
                  key={period}
                  selected={query.finished.period === period}
                  onClick={() =>
                    setQuery((current) => ({
                      ...current,
                      finished: { ...current.finished, period },
                    }))
                  }
                >
                  {t(`orders.period.${period}`)}
                </Chip>
              ))}
            </div>
            <div className="chips" role="group" aria-label={t("orders.filterStatus")}>
              {finishedStatuses.map((status) => (
                <Chip
                  key={status}
                  selected={query.finished.status === status}
                  onClick={() =>
                    setQuery((current) => ({
                      ...current,
                      finished: {
                        ...current.finished,
                        status: current.finished.status === status ? null : status,
                      },
                    }))
                  }
                >
                  {t(`orders.filter.${status}`)}
                </Chip>
              ))}
            </div>
          </>
        )}
      </div>

      {blocked && <Banner tone="warning">{t("orders.blockedNote")}</Banner>}
      {notice && (
        <Banner
          tone={notice.conflict ? "neutral" : "danger"}
          icon={notice.conflict ? "info" : undefined}
          action={
            <Button variant="text" size="s" onClick={() => setNotice(null)}>
              {t("common.close")}
            </Button>
          }
        >
          {notice.text}
        </Banner>
      )}

      {failure !== null && !shown ? (
        <ScreenError title={t("common.errorTitle")} text={t("common.errorText")} retry={retry} />
      ) : (
        <LoadingContent
          className="offers-results"
          ready={shown !== null}
          indicator={gate.indicator}
          skeleton={<SkeletonList rows={4} label={t("orders.loading")} />}
          label={t("orders.loading")}
          swapKey={shown ? JSON.stringify(shown.query) : undefined}
          // Rows carry «Принять»: not over a list about to go away (I521).
          lock
          notice={
            failure !== null && (
              <Banner
                tone="danger"
                action={
                  <Button variant="text" size="s" icon="refresh" onClick={retry.onRetry}>
                    {retry.label}
                  </Button>
                }
              >
                {t("common.errorText")}
              </Banner>
            )
          }
        >
          {shown && (
            <ListBody
              shown={shown}
              wide={wide}
              fresh={fresh}
              when={when}
              blocked={blocked}
              online={online && !held}
              onAccept={accept}
              onDecline={(order) =>
                setDeclining({ id: order.id, number: order.number, version: order.version })
              }
              onResetFilters={() => setQuery({ tab: "finished", finished: ALL_FINISHED })}
            />
          )}
          {shown?.nextCursor && (
            <div className="load-more">
              <Button
                variant="secondary"
                loading={loadingMore}
                disabled={gate.pending}
                onClick={() => loadMore(shown)}
              >
                {t("offers.loadMore")}
              </Button>
            </div>
          )}
        </LoadingContent>
      )}

      <DeclineDialog
        target={declining}
        format={when}
        onClose={() => setDeclining(null)}
        onDeclined={() => void refresh()}
        onProblem={(problem) => {
          setNotice(problem);
          void refresh();
        }}
      />
    </>
  );
}

function ListBody({
  shown,
  wide,
  fresh,
  when,
  blocked,
  online,
  onAccept,
  onDecline,
  onResetFilters,
}: {
  shown: Shown;
  wide: boolean;
  fresh: ReadonlySet<string>;
  when: (iso: string) => string;
  blocked: boolean;
  online: boolean;
  onAccept: (order: SupplierOrderSummary) => Promise<unknown>;
  onDecline: (order: SupplierOrderSummary) => void;
  onResetFilters: () => void;
}) {
  const t = useT();
  const { query, orders } = shown;

  if (orders.length === 0) {
    if (query.tab === "new") {
      return (
        <EmptyState icon="receipt" title={t("orders.emptyNew")} text={t("orders.emptyNewText")} />
      );
    }
    if (query.tab === "in_progress") {
      return <EmptyState icon="package" title={t("orders.emptyInProgress")} />;
    }
    const filtered = query.finished.period !== "all" || query.finished.status !== null;
    return filtered ? (
      <EmptyState
        icon="search"
        title={t("orders.emptyFiltered")}
        action={
          <Button variant="secondary" onClick={onResetFilters}>
            {t("offers.resetFilters")}
          </Button>
        }
      />
    ) : (
      <EmptyState
        icon="archive"
        title={t("orders.emptyFinished")}
        text={t("orders.emptyFinishedText")}
      />
    );
  }

  const row = (order: SupplierOrderSummary) => (
    <OrderRow
      key={order.id}
      order={order}
      wide={wide}
      fresh={fresh.has(order.id)}
      when={when}
      blocked={blocked}
      online={online}
      onAccept={() => onAccept(order)}
      onDecline={() => onDecline(order)}
    />
  );

  const sections: { key: string; title: string | null; orders: SupplierOrderSummary[] }[] =
    query.tab === "in_progress"
      ? workGroups(orders).map((group) => ({
          key: group.group,
          title: t(groupKeys[group.group]),
          orders: group.orders,
        }))
      : [{ key: "all", title: null, orders }];

  if (wide) {
    return (
      <div className="table-wrap">
        <table className="offers-table orders-table">
          <caption className="ac-visually-hidden">{t("orders.title")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("orders.tableNumber")}</th>
              <th scope="col">{t("orders.tableItem")}</th>
              <th scope="col">{t("orders.tableTotal")}</th>
              <th scope="col">{t("orders.tableState")}</th>
              <th scope="col">
                <span className="ac-visually-hidden">{t("offers.tableActions")}</span>
              </th>
            </tr>
          </thead>
          {sections.map((section) => (
            <tbody key={section.key}>
              {section.title && (
                <tr className="orders-table__group">
                  <th scope="rowgroup" colSpan={5} className="ac-text-body-strong">
                    {section.title} · {section.orders.length}
                  </th>
                </tr>
              )}
              {section.orders.map(row)}
            </tbody>
          ))}
        </table>
      </div>
    );
  }

  return (
    <div className="order-sections">
      {sections.map((section) => (
        <section
          key={section.key}
          className="order-section"
          aria-label={section.title ?? undefined}
        >
          {section.title && (
            <h2 className="ac-text-body-strong order-section__title">
              {section.title} · {section.orders.length}
            </h2>
          )}
          <div className="offer-list">{section.orders.map(row)}</div>
        </section>
      ))}
    </div>
  );
}

function OrderRow({
  order,
  wide,
  fresh,
  when,
  blocked,
  online,
  onAccept,
  onDecline,
}: {
  order: SupplierOrderSummary;
  wide: boolean;
  fresh: boolean;
  when: (iso: string) => string;
  blocked: boolean;
  online: boolean;
  onAccept: () => Promise<unknown>;
  onDecline: () => void;
}) {
  const t = useT();
  const title = `${order.item.name.text} × ${order.quantity}`;
  const state: ReactNode =
    order.status === "created" ? (
      <AnswerTimer respondBy={order.respondBy} />
    ) : (
      <>
        <OrderStatus order={order} />
        <WorkDeadline order={order} when={when} />
      </>
    );

  if (wide) {
    return (
      <tr className={fresh ? "order-row--fresh" : undefined}>
        <td className="orders-table__number">
          <a
            className="offer-title"
            href={orderPath(order.id)}
            onClick={(e) => openOrder(e, order.id)}
          >
            {t("orders.number", { number: order.number })}
          </a>
          <div className="ac-text-caption ac-muted">{when(order.createdAt)}</div>
        </td>
        <td className="offers-table__item">
          <div>{title}</div>
          <div className="offer-card__meta">
            <FulfillmentLabel fulfillment={order.fulfillment} />
            <OrderMarks order={order} />
          </div>
        </td>
        <td className="orders-table__money">
          <Money value={order.total} />
        </td>
        <td>
          <div className="order-state">{state}</div>
        </td>
        <td>
          <QuickActions
            order={order}
            blocked={blocked}
            online={online}
            onAccept={onAccept}
            onDecline={onDecline}
            compact
          />
        </td>
      </tr>
    );
  }

  return (
    <article
      className={fresh ? "offer-card order-card order-card--fresh" : "offer-card order-card"}
    >
      <div className="order-state">{state}</div>
      <a
        className="order-card__link"
        href={orderPath(order.id)}
        onClick={(event) => openOrder(event, order.id)}
      >
        <span className="ac-text-caption ac-muted num">
          {t("orders.number", { number: order.number })} · {when(order.createdAt)}
        </span>
        <span className="offer-title">{title}</span>
      </a>
      <div className="offer-card__meta">
        <span className="ac-text-body-strong">
          <Money value={order.total} />
        </span>
        <FulfillmentLabel fulfillment={order.fulfillment} />
        <OrderMarks order={order} />
      </div>
      <QuickActions
        order={order}
        blocked={blocked}
        online={online}
        onAccept={onAccept}
        onDecline={onDecline}
      />
    </article>
  );
}
