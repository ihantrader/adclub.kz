import { isApiError } from "@adclub/api-client";
import { OFFER_ITEM_SEARCH_MIN_LENGTH, type OfferItemSearchResult } from "@adclub/contracts";
import {
  Banner,
  Button,
  EmptyState,
  Icon,
  IconButton,
  SearchField,
  SkeletonList,
} from "@adclub/ui";
import { useEffect, useRef, useState } from "react";
import { apiClient } from "../api";
import { useOnline } from "../connection";
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

type Found =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "failed"; text: string }
  | { status: "ready"; results: OfferItemSearchResult[]; nextOffset: number | null };

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
 */
export function ItemSearch() {
  const t = useT();
  const online = useOnline();
  const opened = useRouteState() as { search?: string } | null;
  const [typed, setTyped] = useState(opened?.search ?? "");
  const [found, setFound] = useState<Found>({ status: "idle" });
  const [loadingMore, setLoadingMore] = useState(false);
  const request = useRef<AbortController | null>(null);

  const search = async (query: string, offset = 0) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    if (offset === 0) setFound({ status: "loading" });
    else setLoadingMore(true);
    try {
      const answer = await apiClient.searchOfferItems({
        query: { q: query, offset },
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setFound((current) => ({
        status: "ready",
        results:
          offset > 0 && current.status === "ready"
            ? [...current.results, ...answer.results]
            : answer.results,
        nextOffset: answer.nextOffset,
      }));
    } catch (error) {
      if (controller.signal.aborted) return;
      setFound({ status: "failed", text: failureText(error, t) });
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
      return;
    }
    const timer = setTimeout(() => void search(query), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
    // `search` is recreated each render; the query is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typed]);

  useEffect(() => () => request.current?.abort(), []);

  const short = typed.trim() !== "" && meaningfulLength(typed) < OFFER_ITEM_SEARCH_MIN_LENGTH;
  // Too short to ask: no results on screen, only the hint.
  const shown: Found =
    meaningfulLength(typed.trim()) < OFFER_ITEM_SEARCH_MIN_LENGTH ? { status: "idle" } : found;

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
      {shown.status === "loading" && <SkeletonList rows={3} label={t("offerSearch.searching")} />}
      {shown.status === "failed" && <Banner tone="danger">{shown.text}</Banner>}
      {shown.status === "ready" &&
        (shown.results.length === 0 ? (
          <EmptyState icon="search" title={t("offerSearch.notFound")} />
        ) : (
          <>
            <ul className="found-list">
              {shown.results.map((result) => (
                <FoundItem key={result.item.id} result={result} />
              ))}
            </ul>
            {shown.nextOffset !== null ? (
              <div className="load-more">
                <Button
                  variant="secondary"
                  loading={loadingMore}
                  onClick={() => search(typed.trim(), shown.nextOffset ?? 0)}
                >
                  {t("offers.loadMore")}
                </Button>
              </div>
            ) : (
              shown.results.length >= 100 && (
                <p className="ac-text-body-s ac-muted">{t("offerSearch.limitReached")}</p>
              )
            )}
          </>
        ))}
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
            <Icon name="package" size={24} />
          )}
        </span>
        <span className="found-item__text">
          <span className="ac-text-body-strong found-item__name">{item.name.text}</span>
          <span className="ac-text-body-s ac-muted">{categoryLine(item)}</span>
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
