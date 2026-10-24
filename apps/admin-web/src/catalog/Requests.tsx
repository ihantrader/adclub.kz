import type {
  AdminCatalogRequest,
  AdminCatalogRequestPage,
  AdminCatalogRequestResponse,
  AdminPriceImportPage,
  CatalogRequestStatus,
  OfferItem,
} from "@adclub/contracts";
import {
  ActionBar,
  Banner,
  Button,
  Dialog,
  EmptyState,
  IconButton,
  LoadingContent,
  SkeletonList,
  StatusBadge,
  TableToolbar,
  TextField,
  TypeMark,
  useToast,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { Fragment, useEffect, useMemo, useState } from "react";
import { apiClient } from "../api";
import { JournalHistory } from "../audit/JournalHistory";
import { loadErrorText } from "../errors";
import { formatMoment } from "../format";
import { FilterSearch, FilterSelect, FlagChips, StatusChips } from "../layout/filters";
import { AppLink, Header, RowTitle, rowLink, Table } from "../layout/layout";
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
import { createChoiceSources } from "../search-select/sources";
import { useLoad } from "../use-load";
import { usePagedList } from "./paged";
import {
  groupByUpload,
  groupTitle,
  REQUEST_STATUS_TEXT,
  requestErrorText,
  requestsText,
  requestSourceText,
  requestTermsText,
  requestTitle,
} from "./request-words";
import { CATALOG_CRUMB, catalogTabs, REQUESTS_CRUMB } from "./shared";

const PAGE = 50;

const STATUSES: { value: CatalogRequestStatus; label: string }[] = [
  { value: "new", label: "Новые" },
  { value: "approved", label: "Добавлено" },
  { value: "rejected", label: "Отклонено" },
];

const supplierSearch = createChoiceSources(apiClient).suppliers();

function itemLine(item: OfferItem): string {
  return [item.brand?.name, item.article].filter(Boolean).join(" · ");
}

/** The filters of «Запросы на позиции» in the address, under the server's names. */
interface RequestFilters {
  status: CatalogRequestStatus;
  q?: string;
  supplierId?: string;
  importId?: string;
  similar?: "true";
}

function filtersOf(query: URLSearchParams): RequestFilters {
  const asked = query.get("status");
  const status: CatalogRequestStatus = asked === "approved" || asked === "rejected" ? asked : "new";
  const value = (name: string) => query.get(name)?.trim() || undefined;
  return {
    status,
    q: value("q"),
    supplierId: value("supplierId"),
    importId: value("importId"),
    similar: query.get("similar") === "true" ? "true" : undefined,
  };
}

function linkOf(filters: RequestFilters): string {
  return withQuery(routePaths.catalogRequests, {
    status: filters.status === "new" ? null : filters.status,
    q: filters.q,
    supplierId: filters.supplierId,
    importId: filters.importId,
    similar: filters.similar,
  });
}

function uploadLabel(fileName: string | null, createdAt: string): string {
  return `${fileName ?? "Прайс"} · ${formatMoment(createdAt)}`;
}

/**
 * «Запросы на позиции» (TASK-047, TASK-080; SCREENS A-MOD-01): rows of
 * suppliers' price lists the catalog had no item for — searched by the
 * name, the article in any spelling or the brand; by the supplier, by one
 * upload, «Есть похожая позиция»; the state as chips with the server's
 * counts under the other filters. Rows of one upload stand together under
 * its head (the file, the supplier, when); each row opens its card.
 */
export function Requests() {
  const location = useLocation();
  const filters = filtersOf(location.query);
  const key = JSON.stringify(filters);
  const list = usePagedList<
    AdminCatalogRequest,
    AdminCatalogRequestPage & {
      items: AdminCatalogRequest[];
    }
  >(async (cursor) => {
    const page = await apiClient.listAdminCatalogRequests({
      query: {
        status: filters.status,
        limit: PAGE,
        ...(filters.q ? { q: filters.q } : {}),
        ...(filters.supplierId ? { supplierId: filters.supplierId } : {}),
        ...(filters.importId ? { importId: filters.importId } : {}),
        ...(filters.similar ? { similar: filters.similar } : {}),
        ...(cursor ? { cursor } : {}),
      },
    });
    return { ...page, items: page.requests };
  }, `requests:${key}`);
  const uploads = useLoad<AdminPriceImportPage | null>(
    () =>
      filters.supplierId
        ? apiClient.listAdminSupplierPriceImports(
            { supplierId: filters.supplierId },
            { query: { limit: 50 } },
          )
        : Promise.resolve(null),
    `request-uploads:${filters.supplierId ?? ""}`,
  );
  const [search, setSearch] = useState(filters.q ?? "");
  const [supplierLabel, setSupplierLabel] = useState<Choice | null>(null);
  const counts = list.first.data?.counts;
  const rows = list.items;

  const set = (patch: Partial<RequestFilters>) =>
    navigateTo(linkOf({ ...filters, ...patch }), { replace: true });
  const filtered = Boolean(filters.q || filters.supplierId || filters.importId || filters.similar);
  const reset = () => {
    setSearch("");
    navigateTo(linkOf({ status: filters.status }), { replace: true });
  };

  // The search goes to the address a moment after typing stops.
  useEffect(() => {
    const trimmed = search.trim();
    if (trimmed === (filters.q ?? "")) return;
    const timer = setTimeout(() => set({ q: trimmed || undefined }), 350);
    return () => clearTimeout(timer);
  });

  // The chosen supplier's name: what was chosen here, else from the rows.
  const supplierOfRows = rows.find((row) => row.supplier.id === filters.supplierId)?.supplier;
  const supplier: Choice | null = !filters.supplierId
    ? null
    : supplierLabel?.id === filters.supplierId
      ? supplierLabel
      : { id: filters.supplierId, label: supplierOfRows?.name ?? "Выбранный поставщик" };

  // The uploads of the chosen supplier; an upload chosen from a group's head is known by its rows.
  const uploadOptions = (uploads.data?.imports ?? []).map((upload) => ({
    value: upload.id,
    label: uploadLabel(upload.fileName, upload.createdAt),
  }));
  const chosenUpload = rows.find((row) => row.import?.id === filters.importId)?.import;
  if (
    filters.importId &&
    chosenUpload &&
    !uploadOptions.some((option) => option.value === filters.importId)
  ) {
    uploadOptions.unshift({
      value: chosenUpload.id,
      label: uploadLabel(chosenUpload.fileName, chosenUpload.createdAt),
    });
  }

  const columns = [
    { key: "what", header: "Что просят" },
    { key: "row", header: "Строка", width: 96, numeric: true },
    ...(filters.status === "approved"
      ? [{ key: "item", header: "Позиция справочника", width: 300 }]
      : filters.status === "rejected"
        ? [{ key: "reason", header: "Причина", width: 300 }]
        : []),
  ];

  return (
    <>
      <Header
        title="Справочник"
        tabs={catalogTabs("requests")}
        actions={
          <IconButton icon="refresh" label="Обновить" size={20} onClick={list.first.reload} />
        }
      />
      <div className="filters__group">
        <div className="filters">
          <FilterSearch
            label="Поиск запросов"
            placeholder="Название, артикул или бренд"
            value={search}
            onChange={setSearch}
            onSubmit={() => set({ q: search.trim() || undefined })}
          />
          <SearchSelect
            compact
            label="Поставщик"
            value={supplier}
            empty="Все"
            placeholder="Название или БИН"
            search={supplierSearch}
            onChange={(choice) => {
              setSupplierLabel(choice);
              set({ supplierId: choice?.id, importId: undefined });
            }}
          />
          {(filters.supplierId || filters.importId) && (
            <FilterSelect
              label="Загрузка"
              value={filters.importId}
              options={uploadOptions}
              onChange={(importId) => set({ importId })}
            />
          )}
        </div>
        <StatusChips<CatalogRequestStatus>
          label="Состояние запросов"
          allLabel={null}
          value={filters.status}
          chips={STATUSES.map((entry) => ({ ...entry, count: counts?.[entry.value] }))}
          onChange={(status) => set({ status: status ?? "new" })}
        />
        <FlagChips<"similar">
          label="Отборы запросов"
          flags={[{ key: "similar", label: "Есть похожая позиция" }]}
          isOn={() => filters.similar === "true"}
          onToggle={(_flag, on) => set({ similar: on ? "true" : undefined })}
        />
      </div>
      {list.first.error !== undefined && (
        <Banner
          tone="danger"
          action={
            <Button variant="text" size="s" onClick={list.first.reload}>
              Повторить
            </Button>
          }
        >
          {loadErrorText(list.first.error)}
        </Banner>
      )}
      <LoadingContent
        ready={list.first.data !== undefined}
        indicator={list.first.indicator}
        label="Загрузка"
        swapKey={list.first.answerKey}
        skeleton={<SkeletonList rows={5} label="Загрузка" />}
      >
        <div className="list-block">
          {rows.length === 0 ? (
            <EmptyState
              icon="package"
              title={
                filtered
                  ? "Ничего не нашлось"
                  : filters.status === "new"
                    ? "Новых запросов нет"
                    : "Запросов нет"
              }
              text={
                filtered
                  ? "Измените поиск или отборы"
                  : "Запросы появляются, когда в прайсе поставщика есть строка, которой нет в справочнике"
              }
              action={
                filtered ? (
                  <Button variant="secondary" onClick={reset}>
                    Сбросить фильтры
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <>
              <TableToolbar total={list.total}>
                {filtered && (
                  <Button variant="text" size="s" onClick={reset}>
                    Сбросить фильтры
                  </Button>
                )}
              </TableToolbar>
              <Table label="Запросы на позиции" columns={columns} className="cat-requests">
                {groupByUpload(rows).map((group) => {
                  const head = group.rows[0]!;
                  return (
                    <Fragment key={`${group.key}:${head.id}`}>
                      <tr className="cat-group">
                        <th scope="rowgroup" colSpan={columns.length}>
                          <span className="cat-group__line">
                            <span className="cat-group__title">{groupTitle(head)}</span>
                            <span>{head.supplier.name}</span>
                            <span className="nowrap">
                              {formatMoment(head.import?.createdAt ?? head.createdAt)}
                            </span>
                            <span className="nowrap">{requestsText(group.rows.length)}</span>
                            {head.import && filters.importId !== head.import.id && (
                              <Button
                                variant="text"
                                size="s"
                                onClick={() =>
                                  set({ importId: head.import?.id, supplierId: head.supplier.id })
                                }
                              >
                                Только эта загрузка
                              </Button>
                            )}
                          </span>
                        </th>
                      </tr>
                      {group.rows.map((request) => (
                        <RequestRow key={request.id} request={request} status={filters.status} />
                      ))}
                    </Fragment>
                  );
                })}
              </Table>
            </>
          )}
          {list.moreError && <Banner tone="danger">{list.moreError}</Banner>}
          {list.hasMore && (
            <Button
              variant="secondary"
              size="s"
              onClick={() => void list.loadMore()}
              loading={list.loadingMore}
            >
              Показать ещё
            </Button>
          )}
        </div>
      </LoadingContent>
    </>
  );
}

function RequestRow({
  request,
  status,
}: {
  request: AdminCatalogRequest;
  status: CatalogRequestStatus;
}) {
  const href = catalogRequestPath(request.id);
  const sub =
    request.source === "manual"
      ? request.category
        ? `Подкатегория по мнению поставщика: ${request.category.name}`
        : null
      : requestTermsText(request.data) || null;
  return (
    <tr {...rowLink(href)}>
      <td>
        <RowTitle href={href} sub={sub ?? undefined}>
          <span className="clamp" title={requestTitle(request.data)}>
            {requestTitle(request.data)}
          </span>
        </RowTitle>
      </td>
      <td className="num">
        {request.import?.rowNo !== null && request.import?.rowNo !== undefined
          ? request.import.rowNo.toLocaleString("ru-RU")
          : "—"}
      </td>
      {status === "approved" && (
        <td className="ac-text-body-s">
          <span className="clamp">{request.item?.name.text ?? "—"}</span>
        </td>
      )}
      {status === "rejected" && (
        <td className="ac-text-body-s">
          <span className="clamp" title={request.rejectReason ?? undefined}>
            {request.rejectReason ?? "—"}
          </span>
        </td>
      )}
    </tr>
  );
}

const SIMILAR_COLUMNS = [
  { key: "item", header: "Позиция" },
  { key: "category", header: "Подкатегория", width: 260 },
  { key: "match", header: "Сопоставить", width: 150, actions: true },
];

/**
 * The card of a request (A-MOD-01; TASK-080): what the row said, the
 * supplier, the price list it came from, the items that look like it;
 * «Создать позицию» (the form of a new item filled from the row), «Это
 * существующая позиция» (a choice with a search), «Отклонить…» with a
 * reason the supplier sees.
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
      <Header
        crumbs={[CATALOG_CRUMB, REQUESTS_CRUMB]}
        title={request ? requestTitle(request.data) : "Запрос на позицию"}
        subtitle={
          request && (
            <>
              <StatusBadge kind="catalogRequest" status={request.status}>
                {REQUEST_STATUS_TEXT[request.status]}
              </StatusBadge>
              <TypeMark icon={request.source === "manual" ? "user" : "fileSpreadsheet"}>
                {request.source === "manual" ? "Вручную" : "Из прайса"}
              </TypeMark>
              {request.decidedAt && (
                <span>
                  Решено {formatMoment(request.decidedAt)}
                  {request.decidedBy?.name ? ` · ${request.decidedBy.name}` : ""}
                </span>
              )}
            </>
          )
        }
        actions={<IconButton icon="refresh" label="Обновить" size={20} onClick={card.reload} />}
      />
      {card.error !== undefined && (
        <Banner
          tone="danger"
          action={
            <Button variant="text" size="s" onClick={card.reload}>
              Повторить
            </Button>
          }
        >
          {loadErrorText(card.error)}
        </Banner>
      )}
      <LoadingContent
        ready={card.data !== undefined}
        indicator={card.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={6} label="Загрузка" />}
      >
        {request && card.data && (
          <div className="detail-stack">
            {error && (
              <Banner
                tone="warning"
                action={
                  <Button
                    variant="text"
                    size="s"
                    onClick={() => {
                      setError(null);
                      card.reload();
                    }}
                  >
                    Обновить данные
                  </Button>
                }
              >
                {error}
              </Banner>
            )}
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
            <section className="card">
              <h2 className="card__title">Строка поставщика</h2>
              <dl className="kv">
                <dt>Артикул</dt>
                <dd>{request.data.article ?? "—"}</dd>
                <dt>Бренд</dt>
                <dd>
                  {request.data.brand ?? "—"}
                  {request.brand && request.brand.name !== request.data.brand && (
                    <span className="kv__note">В справочнике — {request.brand.name}</span>
                  )}
                </dd>
                <dt>Название</dt>
                <dd className="long-text">{request.data.name ?? "—"}</dd>
                {request.source === "price_import" && (
                  <>
                    <dt>Цена и наличие в прайсе</dt>
                    <dd>{requestTermsText(request.data) || "—"}</dd>
                  </>
                )}
                {request.category && (
                  <>
                    <dt>Подкатегория по мнению поставщика</dt>
                    <dd>{request.category.name}</dd>
                  </>
                )}
                {request.comment && (
                  <>
                    <dt>Комментарий поставщика</dt>
                    <dd className="long-text">{request.comment}</dd>
                  </>
                )}
                <dt>Поставщик</dt>
                <dd>
                  <AppLink href={supplierPath(request.supplier.id)}>
                    {request.supplier.name}
                  </AppLink>
                  {request.createdBy?.name && (
                    <span className="kv__note">Отправил {request.createdBy.name}</span>
                  )}
                </dd>
                <dt>Откуда</dt>
                <dd>{requestSourceText(request)}</dd>
                <dt>Пришёл</dt>
                <dd>{formatMoment(request.createdAt)}</dd>
              </dl>
            </section>
            {request.status === "new" && (
              <section className="card">
                <h2 className="card__title">Решение</h2>
                <p className="section__note">
                  {request.source === "manual"
                    ? "Предложение по запросу не создаётся само: поставщик увидит решение в «Модерации» и выставит позицию сам."
                    : "Предложение по запросу не создаётся само: цена в старом прайсе могла устареть. Поставщик выставит его следующей загрузкой прайса."}
                </p>
                <ActionBar
                  label="Решение по запросу"
                  main={
                    <Button
                      disabled={!online || busy}
                      onClick={() => navigateTo(itemFromRequestPath(request.id))}
                    >
                      Создать позицию
                    </Button>
                  }
                  others={[
                    <Button
                      key="link"
                      variant="secondary"
                      disabled={!online || busy}
                      onClick={() => {
                        setLinking(null);
                        setLinkOpen(true);
                      }}
                    >
                      Это существующая позиция
                    </Button>,
                    <Button
                      key="reject"
                      variant="secondary"
                      destructive
                      disabled={!online || busy}
                      onClick={() => {
                        setReason("");
                        setRejectOpen(true);
                      }}
                    >
                      Отклонить…
                    </Button>,
                  ]}
                />
              </section>
            )}
            <section className="section">
              <div className="section__head">
                <h2 className="section__title">Похожие позиции справочника</h2>
              </div>
              {card.data.similar.length === 0 ? (
                <EmptyState
                  compact
                  icon="search"
                  title="Похожих позиций не нашлось"
                  text="По артикулу и названию строки в справочнике ничего нет — позицию, скорее всего, нужно создать"
                />
              ) : (
                <Table label="Похожие позиции справочника" columns={SIMILAR_COLUMNS}>
                  {card.data.similar.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <RowTitle href={catalogItemPath(item.id)} sub={itemLine(item) || undefined}>
                          <span className="clamp">{item.name.text}</span>
                        </RowTitle>
                      </td>
                      <td className="ac-text-body-s">{item.category.name.text}</td>
                      <td className="admin-table__actions">
                        {request.status === "new" ? (
                          <Button
                            variant="secondary"
                            size="s"
                            disabled={!online || busy}
                            onClick={() => void link(item.id)}
                          >
                            Это она
                          </Button>
                        ) : (
                          <span className="ac-muted">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </Table>
              )}
            </section>
            <section className="section">
              <div className="section__head">
                <h2 className="section__title">История</h2>
              </div>
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
