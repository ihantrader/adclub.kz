import type {
  AdminCatalogRequest,
  AdminCatalogRequestResponse,
  CatalogRequestStatus,
  OfferItem,
} from "@adclub/contracts";
import {
  Banner,
  Button,
  Dialog,
  EmptyState,
  LoadingContent,
  Segments,
  SkeletonList,
  TextField,
  useToast,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useMemo, useState } from "react";
import { apiClient } from "../api";
import { JournalHistory } from "../audit/JournalHistory";
import { formatMoment } from "../format";
import {
  catalogItemPath,
  catalogRequestPath,
  itemFromRequestPath,
  navigateTo,
  routePaths,
  supplierPath,
  useLocation,
  withQuery,
} from "../router";
import { SearchSelect } from "../search-select/SearchSelect";
import { SEARCH_PAGE, type Choice } from "../search-select/search-select-core";
import { useLoad } from "../use-load";
import { LoadError, MoreButton, usePaged } from "../vehicles/shared";
import {
  REQUEST_STATUS_TEXT,
  requestErrorText,
  requestSourceText,
  requestTermsText,
  requestTitle,
} from "./request-words";
import { AppLink, CatalogTabs } from "./shared";

const STATUSES: { value: CatalogRequestStatus; label: string }[] = [
  { value: "new", label: "Новые" },
  { value: "approved", label: "Добавлено" },
  { value: "rejected", label: "Отклонено" },
];

function itemLine(item: OfferItem): string {
  return [item.brand?.name, item.article].filter(Boolean).join(" · ");
}

/**
 * «Запросы на позиции» (TASK-047; SCREENS A-MOD-01): rows of suppliers'
 * price lists the catalog had no item for, newest first, by status and
 * supplier; each opens its card.
 */
export function Requests() {
  const { query } = useLocation();
  const asked = query.get("status");
  const status: CatalogRequestStatus = asked === "approved" || asked === "rejected" ? asked : "new";
  const list = usePaged<AdminCatalogRequest>(async (cursor) => {
    const page = await apiClient.listAdminCatalogRequests({
      query: { status, limit: 50, ...(cursor ? { cursor } : {}) },
    });
    return { items: page.requests, total: page.total, nextCursor: page.nextCursor };
  }, `requests:${status}`);
  const counts = useLoad(
    () => apiClient.listAdminCatalogRequests({ query: { limit: 1 } }),
    `requests-counts:${status}`,
  );
  return (
    <>
      <div className="page__head">
        <h1 className="ac-text-title-l page__title">Справочник</h1>
        <Button variant="secondary" size="s" icon="refresh" onClick={list.first.reload}>
          Обновить
        </Button>
      </div>
      <CatalogTabs active="requests" />
      <Segments<CatalogRequestStatus>
        label="Состояние"
        options={STATUSES.map((entry) => ({
          value: entry.value,
          label:
            counts.data !== undefined
              ? `${entry.label} · ${String(counts.data.counts[entry.value])}`
              : entry.label,
        }))}
        value={status}
        onChange={(next) =>
          navigateTo(
            withQuery(routePaths.catalogRequests, { status: next === "new" ? null : next }),
            {
              replace: true,
            },
          )
        }
      />
      <LoadError error={list.first.error} retry={list.first.reload} />
      <LoadingContent
        ready={list.first.data !== undefined}
        indicator={list.first.indicator}
        label="Загрузка"
        swapKey={list.first.answerKey}
        skeleton={<SkeletonList rows={5} label="Загрузка" />}
      >
        <p className="ac-text-body-s ac-muted">Всего: {list.total}</p>
        {list.items.length === 0 ? (
          <EmptyState
            icon="package"
            title={status === "new" ? "Новых запросов нет" : "Запросов нет"}
          />
        ) : (
          <div className="table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th scope="col">Строка прайса</th>
                  <th scope="col">Поставщик</th>
                  <th scope="col">Пришёл</th>
                  <th scope="col">Состояние</th>
                </tr>
              </thead>
              <tbody>
                {list.items.map((request) => (
                  <tr key={request.id}>
                    <td>
                      <div className="cell-stack">
                        <AppLink href={catalogRequestPath(request.id)}>
                          <span className="clamp">{requestTitle(request.data)}</span>
                        </AppLink>
                        <span className="ac-text-caption ac-muted">
                          {requestTermsText(request.data)}
                        </span>
                      </div>
                    </td>
                    <td className="ac-text-body-s">{request.supplier.name}</td>
                    <td className="ac-text-caption ac-muted">{formatMoment(request.createdAt)}</td>
                    <td className="ac-text-body-s">
                      {REQUEST_STATUS_TEXT[request.status]}
                      {request.rejectReason ? `: ${request.rejectReason}` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <MoreButton list={list} />
      </LoadingContent>
    </>
  );
}

/**
 * The card of a request (A-MOD-01): what the row said, the supplier, the
 * price list it came from, the items that look like it; «Создать позицию»
 * (the form of a new item filled from the row), «Это существующая позиция»
 * (a choice with a search), «Отклонить…» with a reason the supplier sees.
 */
export function RequestCard({ requestId }: { requestId: string }) {
  const toast = useToast();
  const online = useOnline();
  const card = useLoad<AdminCatalogRequestResponse>(
    () => apiClient.getAdminCatalogRequest({ requestId }),
    `request:${requestId}`,
  );
  const [linking, setLinking] = useState<Choice | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [historyKey, setHistoryKey] = useState(0);
  const request = card.data?.request;

  const itemSearch = useMemo(
    () =>
      async (query: string): Promise<Choice[]> => {
        const page = await apiClient.listAdminCatalogItems({
          query: { ...(query ? { q: query } : {}), status: "active", limit: SEARCH_PAGE },
        });
        return page.items
          .filter((item) => item.type !== "service")
          .map((item) => ({
            id: item.id,
            label: item.names.ru?.text ?? "Без названия",
            note: [item.brand?.name, item.article].filter(Boolean).join(" · ") || null,
          }));
      },
    [],
  );

  const act = async (work: () => Promise<unknown>, done: string) => {
    setError(null);
    setBusy(true);
    try {
      await work();
      toast.show(done);
      card.reload();
      setHistoryKey((key) => key + 1);
    } catch (thrown) {
      setError(requestErrorText(thrown));
    } finally {
      setBusy(false);
    }
  };

  const link = (itemId: string) =>
    request &&
    act(
      () =>
        apiClient.linkCatalogRequest({ requestId }, { expectedVersion: request.version, itemId }),
      "Запрос закрыт: позиция запомнена для поставщика",
    );

  return (
    <>
      <div className="page__head">
        <div className="stack-xs">
          <h1 className="ac-text-title-l page__title">
            {request ? requestTitle(request.data) : "Запрос на позицию"}
          </h1>
          {request && (
            <span className="ac-text-body-s ac-muted">
              {REQUEST_STATUS_TEXT[request.status]}
              {request.decidedAt ? ` · ${formatMoment(request.decidedAt)}` : ""}
              {request.decidedBy?.name ? ` · ${request.decidedBy.name}` : ""}
            </span>
          )}
        </div>
        <Button variant="secondary" size="s" icon="refresh" onClick={card.reload}>
          Обновить
        </Button>
      </div>
      <CatalogTabs active="requests" />
      <LoadError error={card.error} retry={card.reload} />
      <LoadingContent
        ready={card.data !== undefined}
        indicator={card.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={6} label="Загрузка" />}
      >
        {request && card.data && (
          <div className="detail-stack">
            {error && <Banner tone="warning">{error}</Banner>}
            {request.status === "rejected" && (
              <Banner tone="warning">
                Отклонено: {request.rejectReason}. Причину видит поставщик.
              </Banner>
            )}
            {request.status === "approved" && request.item && (
              <Banner tone="neutral">
                Позиция:{" "}
                <AppLink href={catalogItemPath(request.item.id)}>{request.item.name.text}</AppLink>.
                Следующая загрузка прайса поставщика применит эту строку сама.
              </Banner>
            )}
            <section className="card-section">
              <dl className="facts">
                <div>
                  <dt>Артикул</dt>
                  <dd className="mono">{request.data.article ?? "—"}</dd>
                </div>
                <div>
                  <dt>Бренд</dt>
                  <dd>
                    {request.data.brand ?? "—"}
                    {request.brand && request.brand.name !== request.data.brand
                      ? ` (в справочнике — ${request.brand.name})`
                      : ""}
                  </dd>
                </div>
                <div>
                  <dt>Название</dt>
                  <dd className="long-text">{request.data.name ?? "—"}</dd>
                </div>
                <div>
                  <dt>Цена и наличие в прайсе</dt>
                  <dd>{requestTermsText(request.data) || "—"}</dd>
                </div>
                <div>
                  <dt>Поставщик</dt>
                  <dd>
                    <AppLink href={supplierPath(request.supplier.id)}>
                      {request.supplier.name}
                    </AppLink>
                    {request.createdBy?.name ? ` · ${request.createdBy.name}` : ""}
                  </dd>
                </div>
                <div>
                  <dt>Откуда</dt>
                  <dd>{requestSourceText(request)}</dd>
                </div>
                <div>
                  <dt>Пришёл</dt>
                  <dd className="num">{formatMoment(request.createdAt)}</dd>
                </div>
              </dl>
            </section>
            {request.status === "new" && (
              <section className="card-section">
                <div className="button-row">
                  <Button
                    disabled={!online || busy}
                    onClick={() => navigateTo(itemFromRequestPath(request.id))}
                  >
                    Создать позицию
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={!online || busy}
                    onClick={() => {
                      setLinking(null);
                      setLinkOpen(true);
                    }}
                  >
                    Это существующая позиция
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={!online || busy}
                    onClick={() => {
                      setReason("");
                      setRejectOpen(true);
                    }}
                  >
                    Отклонить…
                  </Button>
                </div>
                <p className="ac-text-caption ac-muted">
                  Предложение по запросу не создаётся само: цена в старом прайсе могла устареть.
                  Поставщик выставит его следующей загрузкой прайса.
                </p>
              </section>
            )}
            <section className="card-section">
              <h2 className="ac-text-heading">Похожие позиции справочника</h2>
              {card.data.similar.length === 0 ? (
                <p className="ac-text-body-s ac-muted">Похожих позиций не нашлось</p>
              ) : (
                <div className="table-wrap">
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th scope="col">Позиция</th>
                        <th scope="col">Подкатегория</th>
                        <th scope="col" aria-label="Действие" />
                      </tr>
                    </thead>
                    <tbody>
                      {card.data.similar.map((item) => (
                        <tr key={item.id}>
                          <td>
                            <div className="cell-stack">
                              <AppLink href={catalogItemPath(item.id)}>
                                <span className="clamp">{item.name.text}</span>
                              </AppLink>
                              <span className="ac-text-caption ac-muted">{itemLine(item)}</span>
                            </div>
                          </td>
                          <td className="ac-text-body-s">{item.category.name.text}</td>
                          <td>
                            {request.status === "new" && (
                              <Button
                                variant="secondary"
                                size="s"
                                disabled={!online || busy}
                                onClick={() => void link(item.id)}
                              >
                                Это она
                              </Button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            <section className="card-section">
              <h2 className="ac-text-heading">История</h2>
              <JournalHistory
                key={historyKey}
                filter={{ entityType: "catalog_request", entityId: requestId }}
                loadKey={`request-history:${requestId}:${String(historyKey)}`}
                caption="История запроса"
                empty="Записей пока нет"
              />
            </section>
          </div>
        )}
      </LoadingContent>
      <Dialog
        open={linkOpen}
        onClose={() => setLinkOpen(false)}
        title="Это существующая позиция"
        actions={
          <>
            <Button
              disabled={!linking || busy}
              onClick={() => {
                setLinkOpen(false);
                if (linking) void link(linking.id);
              }}
            >
              Запомнить для поставщика
            </Button>
            <Button variant="secondary" onClick={() => setLinkOpen(false)}>
              Отмена
            </Button>
          </>
        }
      >
        <div className="dialog-stack">
          <SearchSelect
            label="Позиция справочника"
            value={linking}
            onChange={setLinking}
            search={itemSearch}
            placeholder="Артикул в любом написании или название"
            hint="Строка прайса поставщика будет сопоставляться с этой позицией сама"
          />
        </div>
      </Dialog>
      <Dialog
        open={rejectOpen}
        onClose={() => setRejectOpen(false)}
        title="Отклонить запрос?"
        actions={
          <>
            <Button
              disabled={!reason.trim() || busy}
              onClick={() => {
                setRejectOpen(false);
                if (request) {
                  void act(
                    () =>
                      apiClient.rejectCatalogRequest(
                        { requestId },
                        { expectedVersion: request.version, reason: reason.trim() },
                      ),
                    "Запрос отклонён",
                  );
                }
              }}
            >
              Отклонить
            </Button>
            <Button variant="secondary" onClick={() => setRejectOpen(false)}>
              Отмена
            </Button>
          </>
        }
      >
        <div className="dialog-stack">
          <TextField
            label="Причина"
            value={reason}
            onChange={setReason}
            hint="Её увидит поставщик"
          />
        </div>
      </Dialog>
    </>
  );
}
