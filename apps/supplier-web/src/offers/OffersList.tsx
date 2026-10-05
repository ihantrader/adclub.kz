import type { OfferAvailability, OfferPage, OfferTab, SupplierOffer } from "@adclub/contracts";
import {
  Banner,
  Button,
  Chip,
  EmptyState,
  ScreenError,
  SearchField,
  Segments,
  SkeletonList,
} from "@adclub/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiClient } from "../api";
import { useOnline } from "../connection";
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
}

const EMPTY_QUERY: ListQuery = { tab: "on_sale", q: "", availability: null, withoutPhoto: false };

function queryOf(state: unknown): ListQuery {
  const value = (state as { list?: Partial<ListQuery> } | null)?.list;
  return value ? { ...EMPTY_QUERY, ...value } : EMPTY_QUERY;
}

type Loaded =
  | { status: "loading" }
  | { status: "failed"; error: unknown }
  | {
      status: "ready";
      offers: SupplierOffer[];
      total: number;
      counts: OfferPage["counts"];
      nextCursor: string | null;
    };

const PAGE = 30;
const SEARCH_DELAY_MS = 300;

/**
 * S-OFF-01 «Мои предложения» (TASK-032): «В продаже» and «Снятые» with
 * their counters, a search of the company's own offers, «В наличии / Под
 * заказ» and «Без фото», pages as the list is scrolled. On a phone — cards,
 * from 1024 px — a table; price, availability and term are edited in place.
 * Whether an offer is shown to users and why not is the server's answer
 * (`showcase`), worded here.
 */
export function OffersList() {
  const t = useT();
  const wide = useWide();
  const online = useOnline();
  const opened = useRouteState();
  const [query, setQuery] = useState<ListQuery>(() => queryOf(opened));
  const [typed, setTyped] = useState(query.q);
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [loadingMore, setLoadingMore] = useState(false);
  const request = useRef<AbortController | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  const load = useCallback(async (next: ListQuery, cursor?: string) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    if (cursor) setLoadingMore(true);
    try {
      const page = await apiClient.listSupplierOffers({
        query: {
          tab: next.tab,
          limit: PAGE,
          ...(next.q.trim() && { q: next.q.trim() }),
          ...(next.availability && { availability: next.availability }),
          ...(next.withoutPhoto && { withoutPhoto: "true" as const }),
          ...(cursor && { cursor }),
        },
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setLoaded((current) => ({
        status: "ready",
        offers:
          cursor && current.status === "ready"
            ? [
                ...current.offers,
                ...page.offers.filter((o) => !current.offers.some((c) => c.id === o.id)),
              ]
            : page.offers,
        total: page.total,
        counts: page.counts,
        nextCursor: page.nextCursor,
      }));
    } catch (error) {
      if (controller.signal.aborted) return;
      // A failed next page keeps what is on screen; a failed first page says so.
      setLoaded((current) =>
        cursor && current.status === "ready" ? current : { status: "failed", error },
      );
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

  const nextCursor = loaded.status === "ready" ? loaded.nextCursor : null;
  // The next page when the end of the list comes into view.
  useEffect(() => {
    const target = sentinel.current;
    if (!target || !nextCursor || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) && !loadingMore) {
        void load(query, nextCursor);
      }
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [nextCursor, loadingMore, load, query]);

  const replaceOffer = (offer: SupplierOffer) =>
    setLoaded((current) =>
      current.status === "ready"
        ? {
            ...current,
            offers: current.offers.map((item) => (item.id === offer.id ? offer : item)),
          }
        : current,
    );

  // Withdrawn or returned: the offer leaves this tab and the counters move.
  const moveOffer = (offer: SupplierOffer) =>
    setLoaded((current) => {
      if (current.status !== "ready") return current;
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

  const filtered = query.q.trim() !== "" || query.availability !== null || query.withoutPhoto;
  const counts = loaded.status === "ready" ? loaded.counts : null;
  const tabLabel = (key: "offers.tabOnSale" | "offers.tabWithdrawn", n: number | undefined) =>
    n === undefined ? t(key) : `${t(key)} · ${n}`;
  const schedule = loaded.status === "ready" ? scheduleProblem(loaded.offers) : null;

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

      {loaded.status === "loading" && <SkeletonList rows={4} label={t("offers.loading")} />}
      {loaded.status === "failed" && (
        <ScreenError
          title={t("common.errorTitle")}
          text={t("common.errorText")}
          retry={{ label: t("common.retry"), onRetry: () => load(query) }}
        />
      )}
      {loaded.status === "ready" &&
        (loaded.offers.length === 0 ? (
          filtered ? (
            <EmptyState
              icon="search"
              title={t("offers.nothingFound")}
              text={t("offers.nothingFoundText")}
              action={
                <Button
                  variant="secondary"
                  onClick={() => {
                    setTyped("");
                    setQuery({ ...EMPTY_QUERY, tab: query.tab });
                  }}
                >
                  {t("offers.resetFilters")}
                </Button>
              }
            />
          ) : query.tab === "withdrawn" ? (
            <EmptyState icon="archive" title={t("offers.emptyWithdrawn")} />
          ) : (
            <EmptyState
              icon="tags"
              title={t("offers.emptyTitle")}
              text={t("offers.emptyText")}
              action={addButton}
            />
          )
        ) : wide ? (
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
                {loaded.offers.map((offer) => (
                  <OfferTableRow
                    key={offer.id}
                    offer={offer}
                    onChanged={replaceOffer}
                    onMoved={moveOffer}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="offer-list">
            {loaded.offers.map((offer) => (
              <OfferCardRow
                key={offer.id}
                offer={offer}
                onChanged={replaceOffer}
                onMoved={moveOffer}
              />
            ))}
          </div>
        ))}

      {loaded.status === "ready" && loaded.nextCursor && (
        <div ref={sentinel} className="load-more">
          <Button
            variant="secondary"
            loading={loadingMore}
            onClick={() => load(query, loaded.nextCursor ?? undefined)}
          >
            {t("offers.loadMore")}
          </Button>
        </div>
      )}
    </>
  );
}
