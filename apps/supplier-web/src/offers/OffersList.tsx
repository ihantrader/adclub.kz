import type { OfferAvailability, OfferPage, OfferTab, SupplierOffer } from "@adclub/contracts";
import {
  Banner,
  Button,
  Chip,
  EmptyState,
  LoadingContent,
  ScreenError,
  SearchField,
  Segments,
  SkeletonList,
  useLoadingGate,
} from "@adclub/ui";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { apiClient } from "../api";
import { useOnline } from "@adclub/web-session";
import { useT } from "../i18n";
import { navigate, replaceRouteState, useRouteState } from "../router";
import { OfferCardRow, OfferTableRow } from "./OfferRow";
import { scheduleProblem } from "./offer-rules";
import { useWide } from "./use-wide";

/** What the list is asked for; kept with the page's history entry (a reload keeps it). */
interface ListQuery {
  tab: OfferTab;
  q: string;
  availability: OfferAvailability | null;
  withoutPhoto: boolean;
  /** «Услуги» (TASK-019): only offers on services. */
  services: boolean;
}

const EMPTY_QUERY: ListQuery = {
  tab: "on_sale",
  q: "",
  availability: null,
  withoutPhoto: false,
  services: false,
};

function queryOf(state: unknown): ListQuery {
  const value = (state as { list?: Partial<ListQuery> } | null)?.list;
  return value ? { ...EMPTY_QUERY, ...value } : EMPTY_QUERY;
}

/** The list on screen, with the query it answers. */
interface Shown {
  query: ListQuery;
  offers: SupplierOffer[];
  total: number;
  counts: OfferPage["counts"];
  nextCursor: string | null;
}

const PAGE = 30;
const SEARCH_DELAY_MS = 300;

/**
 * S-OFF-01 «Мои предложения» (TASK-032): «В продаже» and «Снятые» with
 * their counters, a search of the company's own offers, «В наличии / Под
 * заказ» and «Без фото», pages as the list is scrolled. On a phone — cards,
 * from 1024 px — a table; price, availability and term are edited in place.
 * Whether an offer is shown to users and why not is the server's answer
 * (`showcase`), worded here.
 *
 * Loading follows the one rule (DESIGN 7.6, D-069): a tab, a filter or a
 * search keeps the list on screen until the new one arrives — dimmed, under
 * the refresh line, not to be edited if that takes longer than a moment —
 * and only the last of quick switches is shown.
 */
export function OffersList() {
  const t = useT();
  const wide = useWide();
  const online = useOnline();
  const opened = useRouteState();
  const gate = useLoadingGate();
  const [query, setQuery] = useState<ListQuery>(() => queryOf(opened));
  const [typed, setTyped] = useState(query.q);
  const [shown, setShown] = useState<Shown | null>(null);
  /** The latest list that could not be loaded; the list on screen stays. */
  const [failure, setFailure] = useState<unknown>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const request = useRef<AbortController | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const { begin, settle } = gate;

  const load = useCallback(
    async (next: ListQuery) => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setLoadingMore(false);
      const ticket = begin();
      try {
        const page = await apiClient.listSupplierOffers({
          query: {
            tab: next.tab,
            limit: PAGE,
            ...(next.q.trim() && { q: next.q.trim() }),
            ...(next.availability && { availability: next.availability }),
            ...(next.withoutPhoto && { withoutPhoto: "true" as const }),
            ...(next.services && { kind: "services" as const }),
          },
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        settle(ticket, () => {
          setShown({
            query: next,
            offers: page.offers,
            total: page.total,
            counts: page.counts,
            nextCursor: page.nextCursor,
          });
          setFailure(null);
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        settle(ticket, () => setFailure(error));
      }
    },
    [begin, settle],
  );

  /** The next page of the list on screen: added below, the scroll stays where it is. */
  const loadMore = useCallback(async (list: Shown) => {
    if (!list.nextCursor) return;
    const controller = new AbortController();
    request.current = controller;
    setLoadingMore(true);
    try {
      const page = await apiClient.listSupplierOffers({
        query: {
          tab: list.query.tab,
          limit: PAGE,
          ...(list.query.q.trim() && { q: list.query.q.trim() }),
          ...(list.query.availability && { availability: list.query.availability }),
          ...(list.query.withoutPhoto && { withoutPhoto: "true" as const }),
          ...(list.query.services && { kind: "services" as const }),
          cursor: list.nextCursor,
        },
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setShown((current) =>
        current && current.query === list.query
          ? {
              ...current,
              offers: [
                ...current.offers,
                ...page.offers.filter((o) => !current.offers.some((c) => c.id === o.id)),
              ],
              total: page.total,
              counts: page.counts,
              nextCursor: page.nextCursor,
            }
          : current,
      );
    } catch {
      // A failed next page keeps what is on screen; «Показать ещё» tries again.
    } finally {
      if (request.current === controller) setLoadingMore(false);
    }
  }, []);

  // The query is remembered with the history entry, and asked for.
  useEffect(() => {
    replaceRouteState({ list: query });
    void load(query);
  }, [query, load]);

  // The search is asked a moment after typing stops.
  useEffect(() => {
    if (typed === query.q) return;
    const timer = setTimeout(
      () => setQuery((current) => ({ ...current, q: typed })),
      SEARCH_DELAY_MS,
    );
    return () => clearTimeout(timer);
  }, [typed, query.q]);

  useEffect(() => () => request.current?.abort(), []);

  // The next page when the end of the list comes into view — not while
  // another list is on its way to replace this one.
  const more = shown?.nextCursor && !gate.pending ? shown : null;
  useEffect(() => {
    const target = sentinel.current;
    if (!target || !more || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) && !loadingMore) void loadMore(more);
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [more, loadingMore, loadMore]);

  const replaceOffer = (offer: SupplierOffer) =>
    setShown((current) =>
      current
        ? {
            ...current,
            offers: current.offers.map((item) => (item.id === offer.id ? offer : item)),
          }
        : current,
    );

  // Withdrawn or returned: the offer leaves this tab and the counters move.
  const moveOffer = (offer: SupplierOffer) =>
    setShown((current) => {
      if (!current) return current;
      const toWithdrawn = offer.status === "withdrawn";
      return {
        ...current,
        offers: current.offers.filter((item) => item.id !== offer.id),
        total: Math.max(0, current.total - 1),
        counts: {
          onSale: current.counts.onSale + (toWithdrawn ? -1 : 1),
          withdrawn: current.counts.withdrawn + (toWithdrawn ? 1 : -1),
        },
      };
    });

  const counts = shown?.counts ?? null;
  const tabLabel = (key: "offers.tabOnSale" | "offers.tabWithdrawn", n: number | undefined) =>
    n === undefined ? t(key) : `${t(key)} · ${n}`;
  const schedule = shown ? scheduleProblem(shown.offers) : null;
  const retry = { label: t("common.retry"), onRetry: () => load(query) };

  const addButton = (
    <Button icon="plus" onClick={() => navigate("offerSearch")} disabled={!online}>
      {t("offers.add")}
    </Button>
  );

  return (
    <>
      <div className="page__head">
        <h1 className="ac-text-title page__title">{t("offers.title")}</h1>
        {addButton}
      </div>

      <div className="offers-controls">
        <Segments<OfferTab>
          label={t("offers.title")}
          value={query.tab}
          onChange={(tab) => setQuery((current) => ({ ...current, tab }))}
          options={[
            { value: "on_sale", label: tabLabel("offers.tabOnSale", counts?.onSale) },
            { value: "withdrawn", label: tabLabel("offers.tabWithdrawn", counts?.withdrawn) },
          ]}
        />
        <SearchField
          label={t("offers.searchLabel")}
          placeholder={t("offers.searchPlaceholder")}
          clearLabel={t("offers.clearSearch")}
          value={typed}
          maxLength={100}
          onChange={setTyped}
        />
        <div className="chips" role="group" aria-label={t("offers.filters")}>
          <Chip
            selected={query.availability === "in_stock"}
            onClick={() =>
              setQuery((current) => ({
                ...current,
                availability: current.availability === "in_stock" ? null : "in_stock",
              }))
            }
          >
            {t("offers.inStock")}
          </Chip>
          <Chip
            selected={query.availability === "on_order"}
            onClick={() =>
              setQuery((current) => ({
                ...current,
                availability: current.availability === "on_order" ? null : "on_order",
              }))
            }
          >
            {t("offers.onOrder")}
          </Chip>
          <Chip
            selected={query.withoutPhoto}
            onClick={() =>
              setQuery((current) => ({ ...current, withoutPhoto: !current.withoutPhoto }))
            }
          >
            {t("offers.filterNoPhoto")}
          </Chip>
          <Chip
            selected={query.services}
            onClick={() => setQuery((current) => ({ ...current, services: !current.services }))}
          >
            {t("offers.filterServices")}
          </Chip>
        </div>
      </div>

      {schedule && (
        <Banner
          tone="warning"
          action={
            <Button variant="text" size="s" onClick={() => navigate("company")}>
              {t("offers.openCompany")}
            </Button>
          }
        >
          {t(schedule === "hours_not_set" ? "offers.scheduleBanner" : "offers.noWorkingDayBanner")}
        </Banner>
      )}

      {failure !== null && !shown ? (
        <ScreenError title={t("common.errorTitle")} text={t("common.errorText")} retry={retry} />
      ) : (
        <LoadingContent
          className="offers-results"
          ready={shown !== null}
          indicator={gate.indicator}
          skeleton={<SkeletonList rows={4} label={t("offers.loading")} />}
          label={t("offers.loading")}
          swapKey={shown ? JSON.stringify(shown.query) : undefined}
          // Prices are edited in the rows: not over a list about to go away.
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
              addButton={addButton}
              onChanged={replaceOffer}
              onMoved={moveOffer}
              onReset={() => {
                setTyped("");
                setQuery({ ...EMPTY_QUERY, tab: shown.query.tab });
              }}
            />
          )}
          {shown?.nextCursor && (
            <div ref={sentinel} className="load-more">
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
    </>
  );
}

/** The offers of the list on screen — what it answers, not what is being asked for now. */
function ListBody({
  shown,
  wide,
  addButton,
  onChanged,
  onMoved,
  onReset,
}: {
  shown: Shown;
  wide: boolean;
  addButton: ReactNode;
  onChanged: (offer: SupplierOffer) => void;
  onMoved: (offer: SupplierOffer) => void;
  onReset: () => void;
}) {
  const t = useT();
  const { query, offers } = shown;
  const filtered =
    query.q.trim() !== "" || query.availability !== null || query.withoutPhoto || query.services;

  if (offers.length === 0) {
    if (filtered) {
      return (
        <EmptyState
          icon="search"
          title={t("offers.nothingFound")}
          text={t("offers.nothingFoundText")}
          action={
            <Button variant="secondary" onClick={onReset}>
              {t("offers.resetFilters")}
            </Button>
          }
        />
      );
    }
    return query.tab === "withdrawn" ? (
      <EmptyState icon="archive" title={t("offers.emptyWithdrawn")} />
    ) : (
      <EmptyState
        icon="tags"
        title={t("offers.emptyTitle")}
        text={t("offers.emptyText")}
        action={addButton}
      />
    );
  }

  if (wide) {
    return (
      <div className="table-wrap">
        <table className="offers-table">
          <caption className="ac-visually-hidden">{t("offers.title")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("offers.tableItem")}</th>
              {query.tab === "on_sale" ? (
                <th scope="col" colSpan={3}>
                  {t("offers.tablePriceTerms")}
                </th>
              ) : (
                <>
                  <th scope="col">{t("offers.price")}</th>
                  <th scope="col">{t("offers.availability")}</th>
                  <th scope="col">{t("offers.leadDays")}</th>
                </>
              )}
              <th scope="col">{t("offers.receiving")}</th>
              <th scope="col">{t("offers.tableActive")}</th>
              <th scope="col">
                <span className="ac-visually-hidden">{t("offers.tableActions")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {offers.map((offer) => (
              <OfferTableRow key={offer.id} offer={offer} onChanged={onChanged} onMoved={onMoved} />
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="offer-list">
      {offers.map((offer) => (
        <OfferCardRow key={offer.id} offer={offer} onChanged={onChanged} onMoved={onMoved} />
      ))}
    </div>
  );
}
