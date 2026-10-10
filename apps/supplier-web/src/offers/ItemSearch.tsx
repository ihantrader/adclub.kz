import { isApiError } from "@adclub/api-client";
import { OFFER_ITEM_SEARCH_MIN_LENGTH, type OfferItemSearchResult } from "@adclub/contracts";
import {
  Banner,
  Button,
  EmptyState,
  Icon,
  IconButton,
  LoadingContent,
  SearchField,
  SkeletonList,
  useLoadingGate,
} from "@adclub/ui";
import { useEffect, useRef, useState } from "react";
import { apiClient } from "../api";
import { useOnline } from "@adclub/web-session";
import { useT, type Translate } from "../i18n";
import { categoryLine, meaningfulLength } from "./offer-rules";
import {
  goBack,
  navigate,
  navigateTo,
  offerPath,
  replaceRouteState,
  useRouteState,
} from "../router";

const SEARCH_DELAY_MS = 400;

/** The results on screen, with the query they answer. */
interface Found {
  query: string;
  results: OfferItemSearchResult[];
  nextOffset: number | null;
}

function failureText(error: unknown, t: Translate): string {
  if (isApiError(error) && error.code === "RATE_LIMITED") {
    const details = error.details as { retryAfterSeconds?: unknown } | undefined;
    const seconds = Math.max(1, Math.ceil(Number(details?.retryAfterSeconds ?? 60)));
    return t("offerSearch.rateLimited", { seconds });
  }
  if (isApiError(error) && error.code === "NETWORK_ERROR") return t("common.offline");
  return t("common.errorText");
}

/**
 * S-OFF-02 «Поиск позиции справочника» (TASK-032): only by a query — the
 * whole catalog is never shown (the server refuses fewer than three
 * letters or digits, and pages no further than its first matches). An
 * article in any spelling or a name in any language. An item already on
 * sale opens its offer; another one opens the form of a new offer.
 *
 * Typing on keeps the results of the previous query on screen until the
 * next ones arrive (DESIGN 7.6, D-069); a skeleton only for the first.
 */
export function ItemSearch() {
  const t = useT();
  const online = useOnline();
  const opened = useRouteState() as { search?: string } | null;
  const gate = useLoadingGate();
  const [typed, setTyped] = useState(opened?.search ?? "");
  const [found, setFound] = useState<Found | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const request = useRef<AbortController | null>(null);
  const { begin, settle, cancel } = gate;

  const search = async (query: string) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoadingMore(false);
    const ticket = begin();
    try {
      const answer = await apiClient.searchOfferItems({
        query: { q: query, offset: 0 },
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      settle(ticket, () => {
        setFound({ query, results: answer.results, nextOffset: answer.nextOffset });
        setFailure(null);
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      settle(ticket, () => setFailure(failureText(error, t)));
    }
  };

  /** «Показать ещё»: the next matches below the ones on screen. */
  const searchMore = async (list: Found) => {
    if (list.nextOffset === null) return;
    const controller = new AbortController();
    request.current = controller;
    setLoadingMore(true);
    try {
      const answer = await apiClient.searchOfferItems({
        query: { q: list.query, offset: list.nextOffset },
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setFound((current) =>
        current && current.query === list.query
          ? {
              ...current,
              results: [...current.results, ...answer.results],
              nextOffset: answer.nextOffset,
            }
          : current,
      );
    } catch (error) {
      if (!controller.signal.aborted) setFailure(failureText(error, t));
    } finally {
      if (request.current === controller) setLoadingMore(false);
    }
  };

  // Asked a moment after typing stops; fewer than three letters or digits — a hint, no request.
  useEffect(() => {
    const query = typed.trim();
    replaceRouteState({ search: typed });
    if (meaningfulLength(query) < OFFER_ITEM_SEARCH_MIN_LENGTH) {
      request.current?.abort();
      cancel();
      return;
    }
    const timer = setTimeout(() => void search(query), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
    // `search` is recreated each render; the query is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typed]);

  useEffect(() => () => request.current?.abort(), []);

  const tooShortToAsk = meaningfulLength(typed.trim()) < OFFER_ITEM_SEARCH_MIN_LENGTH;
  const short = typed.trim() !== "" && tooShortToAsk;
  // Too short to ask: no results on screen, only the hint.
  const asked = !tooShortToAsk;

  return (
    <>
      <div className="page__head page__head--back">
        <IconButton icon="arrowLeft" label={t("common.back")} onClick={() => goBack("offers")} />
        <h1 className="ac-text-title page__title">{t("offerSearch.title")}</h1>
      </div>

      <div className="stack-s">
        <SearchField
          label={t("offerSearch.label")}
          placeholder={t("offerSearch.placeholder")}
          clearLabel={t("offers.clearSearch")}
          value={typed}
          maxLength={100}
          autoFocus
          enterKeyHint="search"
          onChange={setTyped}
        />
        <p
          className={
            short
              ? "ac-text-body-s search-hint search-hint--short"
              : "ac-text-body-s ac-muted search-hint"
          }
        >
          {short ? t("offerSearch.tooShort") : t("offerSearch.hint")}
        </p>
      </div>

      {!online && <Banner icon="wifiOff">{t("offerSearch.offline")}</Banner>}
      {asked && failure !== null && !found && <Banner tone="danger">{failure}</Banner>}
      {asked && (found !== null || gate.pending) && (
        <LoadingContent
          className="search-results"
          ready={found !== null}
          indicator={gate.indicator}
          skeleton={<SkeletonList rows={3} label={t("offerSearch.searching")} />}
          label={t("offerSearch.searching")}
          swapKey={found?.query}
          notice={failure !== null && found && <Banner tone="danger">{failure}</Banner>}
        >
          {found &&
            (found.results.length === 0 ? (
              <EmptyState icon="search" title={t("offerSearch.notFound")} />
            ) : (
              <>
                <ul className="found-list">
                  {found.results.map((result) => (
                    <FoundItem key={result.item.id} result={result} />
                  ))}
                </ul>
                {found.nextOffset !== null ? (
                  <div className="load-more">
                    <Button
                      variant="secondary"
                      loading={loadingMore}
                      disabled={gate.pending}
                      onClick={() => searchMore(found)}
                    >
                      {t("offers.loadMore")}
                    </Button>
                  </div>
                ) : (
                  found.results.length >= 100 && (
                    <p className="ac-text-body-s ac-muted">{t("offerSearch.limitReached")}</p>
                  )
                )}
              </>
            ))}
        </LoadingContent>
      )}
    </>
  );
}

/** A found item: its offer if the company has one, else the form of a new offer. */
function FoundItem({ result }: { result: OfferItemSearchResult }) {
  const t = useT();
  const { item, offer } = result;
  const line = [item.brand?.name, item.article].filter(Boolean).join(" · ");
  const open = () => {
    if (offer) navigateTo(offerPath(offer.id));
    else navigate("offerNew", { state: { item } });
  };
  return (
    <li>
      <button type="button" className="found-item" onClick={open}>
        <span className="found-item__thumb" aria-hidden="true">
          {item.photo ? (
            <img src={item.photo.thumbUrl} alt="" loading="lazy" />
          ) : (
            <Icon name={item.type === "service" ? "settings" : "package"} size={24} />
          )}
        </span>
        <span className="found-item__text">
          <span className="ac-text-body-strong found-item__name">{item.name.text}</span>
          <span className="ac-text-body-s ac-muted">
            {item.type === "service"
              ? `${t("offers.service")} · ${categoryLine(item)}`
              : categoryLine(item)}
          </span>
          {line && <span className="ac-text-body-s num">{line}</span>}
          {offer && (
            <span className="ac-text-body-s found-item__already">
              <Icon name="check" size={16} />
              {t(
                offer.status === "withdrawn"
                  ? "offerSearch.alreadyWithdrawn"
                  : "offerSearch.already",
              )}
            </span>
          )}
        </span>
        <Icon name="chevronRight" size={20} className="ac-muted" />
      </button>
    </li>
  );
}
