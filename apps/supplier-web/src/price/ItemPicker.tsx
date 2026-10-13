import { isApiError } from "@adclub/api-client";
import {
  OFFER_ITEM_SEARCH_MIN_LENGTH,
  type OfferItem,
  type OfferItemSearchResult,
} from "@adclub/contracts";
import { Banner, Button, Dialog, Icon, SearchField, Spinner } from "@adclub/ui";
import { useEffect, useRef, useState } from "react";
import { apiClient } from "../api";
import { useT, type Translate } from "../i18n";
import { categoryLine, meaningfulLength } from "../offers/offer-rules";

const SEARCH_DELAY_MS = 400;

function searchFailure(error: unknown, t: Translate): string {
  if (isApiError(error) && error.code === "RATE_LIMITED") {
    const details = error.details as { retryAfterSeconds?: unknown } | undefined;
    const seconds = Math.max(1, Math.ceil(Number(details?.retryAfterSeconds ?? 60)));
    return t("offerSearch.rateLimited", { seconds });
  }
  if (isApiError(error) && error.code === "NETWORK_ERROR") return t("common.offline");
  return t("common.errorText");
}

/**
 * «Другая позиция» and «Найти вручную» of S-PRICE-03 (TASK-048): the same
 * search as «Добавить позицию» (S-OFF-02, `GET /supplier/catalog/items/search`)
 * — only by a query, an article in any spelling or a name, with its
 * refusals in words. A service is shown but can't be chosen: services are
 * not set from a price list.
 */
export function ItemPicker({
  open,
  initial,
  onClose,
  onPick,
}: {
  open: boolean;
  /** What the row of the file says: the search starts from it. */
  initial: string;
  onClose: () => void;
  onPick: (item: OfferItem) => void;
}) {
  const t = useT();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("picker.title")}
      actions={
        <Button variant="secondary" onClick={onClose}>
          {t("common.cancel")}
        </Button>
      }
    >
      {/* Mounted anew each time the dialog opens: the search starts from the row again. */}
      {open && <PickerSearch initial={initial} onPick={onPick} />}
    </Dialog>
  );
}

function PickerSearch({ initial, onPick }: { initial: string; onPick: (item: OfferItem) => void }) {
  const t = useT();
  const [typed, setTyped] = useState(initial);
  const [results, setResults] = useState<OfferItemSearchResult[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const request = useRef<AbortController | null>(null);

  useEffect(() => {
    const query = typed.trim();
    if (meaningfulLength(query) < OFFER_ITEM_SEARCH_MIN_LENGTH) {
      // An answer still on its way is dropped; its `finally` ends «searching».
      request.current?.abort();
      return;
    }
    const timer = setTimeout(() => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setSearching(true);
      apiClient
        .searchOfferItems({ query: { q: query, offset: 0 }, signal: controller.signal })
        .then(
          (answer) => {
            if (controller.signal.aborted) return;
            setResults(answer.results);
            setFailure(null);
          },
          (error: unknown) => {
            if (controller.signal.aborted) return;
            setFailure(searchFailure(error, t));
          },
        )
        .finally(() => {
          if (request.current === controller) setSearching(false);
        });
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [typed, t]);

  useEffect(() => () => request.current?.abort(), []);

  const short =
    typed.trim() !== "" && meaningfulLength(typed.trim()) < OFFER_ITEM_SEARCH_MIN_LENGTH;

  return (
    <div className="picker">
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
          short ? "ac-text-body-s search-hint search-hint--short" : "ac-text-body-s ac-muted"
        }
      >
        {short ? t("offerSearch.tooShort") : t("offerSearch.hint")}
      </p>
      {failure && <Banner tone="danger">{failure}</Banner>}
      {searching && results === null && <Spinner />}
      {results !== null && results.length === 0 && (
        <p className="ac-text-body ac-muted">{t("offerSearch.notFound")}</p>
      )}
      {results !== null && results.length > 0 && (
        <ul className="found-list picker__list" aria-busy={searching}>
          {results.map(({ item }) => {
            const service = item.type === "service";
            const line = [item.brand?.name, item.article].filter(Boolean).join(" · ");
            return (
              <li key={item.id}>
                <button
                  type="button"
                  className="found-item"
                  disabled={service}
                  onClick={() => onPick(item)}
                >
                  <span className="found-item__thumb" aria-hidden="true">
                    {item.photo ? (
                      <img src={item.photo.thumbUrl} alt="" loading="lazy" />
                    ) : (
                      <Icon name={service ? "settings" : "package"} size={24} />
                    )}
                  </span>
                  <span className="found-item__text">
                    <span className="ac-text-body-strong found-item__name">{item.name.text}</span>
                    <span className="ac-text-body-s ac-muted">{categoryLine(item)}</span>
                    {line && <span className="ac-text-body-s num">{line}</span>}
                    {service && (
                      <span className="ac-text-body-s ac-muted">{t("picker.service")}</span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
