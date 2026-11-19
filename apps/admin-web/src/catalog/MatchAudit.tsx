import type {
  AdminPriceMatchAudit,
  OfferItem,
  PriceMatchAuditBucketId,
  PriceMatchAuditCard,
  PriceMatchAuditMetrics,
  PriceMatchAuditPage,
  PriceMatchAuditStatus,
} from "@adclub/contracts";
import {
  ActionBar,
  AiBadge,
  Banner,
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  IconButton,
  LoadingContent,
  Segments,
  SkeletonList,
  StatusBadge,
  TableToolbar,
  TextAreaField,
  useToast,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useMemo, useState } from "react";
import { apiClient } from "../api";
import { JournalHistory } from "../audit/JournalHistory";
import { loadErrorText } from "../errors";
import { formatMoment } from "../format";
import { FilterSelect, StatusChips } from "../layout/filters";
import { AppLink, Header, RowTitle, rowLink, Table } from "../layout/layout";
import {
  catalogItemPath,
  matchAuditPath,
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
import {
  AUDIT_STATUS_TEXT,
  auditErrorText,
  auditRowTitle,
  BUCKET_TEXT,
  confidenceText,
  percentText,
  reasonText,
  wrongConsequences,
  wrongResultText,
} from "./match-audit-words";
import { usePagedList } from "./paged";
import { CATALOG_CRUMB, catalogTabs, MATCH_AUDIT_CRUMB } from "./shared";

const PAGE = 50;

const STATUSES: { value: PriceMatchAuditStatus; label: string }[] = [
  { value: "pending", label: "Ждут проверки" },
  { value: "correct", label: "Верно" },
  { value: "wrong", label: "Неверно" },
];

const BUCKETS = (Object.keys(BUCKET_TEXT) as PriceMatchAuditBucketId[]).map((value) => ({
  value,
  label: BUCKET_TEXT[value],
}));

const PERIODS = [
  { value: "7", label: "7 дней" },
  { value: "30", label: "30 дней" },
  { value: "90", label: "90 дней" },
] as const;

type Period = (typeof PERIODS)[number]["value"];

const supplierSearch = createChoiceSources(apiClient).suppliers();

function itemLine(item: OfferItem): string {
  return [item.brand?.name, item.article].filter(Boolean).join(" · ");
}

interface AuditFilters {
  status: PriceMatchAuditStatus;
  supplierId?: string;
  bucket?: PriceMatchAuditBucketId;
  period: Period;
}

function filtersOf(query: URLSearchParams): AuditFilters {
  const status = query.get("status");
  const bucket = query.get("bucket");
  const period = query.get("period");
  return {
    status: status === "correct" || status === "wrong" ? status : "pending",
    supplierId: query.get("supplierId")?.trim() || undefined,
    bucket: BUCKETS.some((entry) => entry.value === bucket)
      ? (bucket as PriceMatchAuditBucketId)
      : undefined,
    period: period === "7" || period === "90" ? period : "30",
  };
}

function linkOf(filters: AuditFilters): string {
  return withQuery(routePaths.catalogMatchAudit, {
    status: filters.status === "pending" ? null : filters.status,
    supplierId: filters.supplierId,
    bucket: filters.bucket,
    period: filters.period === "30" ? null : filters.period,
  });
}

/**
 * «Аудит сопоставлений» (TASK-065; SCREENS A-MOD-04): the accuracy of AI by
 * the checks of a period and by confidence bucket — what the threshold
 * `price_match_confidence_threshold` is set by — and the rows of price lists
 * where suppliers accepted the item AI chose, put aside for a check, the
 * queue oldest first.
 */
export function MatchAudit() {
  const location = useLocation();
  const filters = filtersOf(location.query);
  const key = JSON.stringify({ ...filters, period: undefined });
  const list = usePagedList<
    AdminPriceMatchAudit,
    PriceMatchAuditPage & { items: AdminPriceMatchAudit[] }
  >(async (cursor) => {
    const page = await apiClient.listPriceMatchAudits({
      query: {
        status: filters.status,
        limit: PAGE,
        ...(filters.supplierId ? { supplierId: filters.supplierId } : {}),
        ...(filters.bucket ? { bucket: filters.bucket } : {}),
        ...(cursor ? { cursor } : {}),
      },
    });
    return { ...page, items: page.audits };
  }, `match-audit:${key}`);
  const metrics = useLoad<PriceMatchAuditMetrics>(
    () => apiClient.getPriceMatchAuditMetrics({ query: { days: filters.period } }),
    `match-audit-metrics:${filters.period}`,
  );
  const [supplierLabel, setSupplierLabel] = useState<Choice | null>(null);
  const counts = list.first.data?.counts;
  const rows = list.items;
  const set = (patch: Partial<AuditFilters>) =>
    navigateTo(linkOf({ ...filters, ...patch }), { replace: true });
  const filtered = Boolean(filters.supplierId || filters.bucket);
  const supplierOfRows = rows.find((row) => row.supplier.id === filters.supplierId)?.supplier;
  const supplier: Choice | null = !filters.supplierId
    ? null
    : supplierLabel?.id === filters.supplierId
      ? supplierLabel
      : { id: filters.supplierId, label: supplierOfRows?.name ?? "Выбранный поставщик" };

  const columns = [
    { key: "row", header: "Строка прайса" },
    { key: "item", header: "Предложил ИИ", width: 300 },
    { key: "confidence", header: "Уверенность", width: 120, numeric: true },
    { key: "supplier", header: "Поставщик", width: 200 },
    {
      key: "when",
      header: filters.status === "pending" ? "Принято поставщиком" : "Проверено",
      width: 170,
    },
  ];

  return (
    <>
      <Header
        title="Справочник"
        tabs={catalogTabs("matchAudit")}
        actions={
          <IconButton
            icon="refresh"
            label="Обновить"
            size={20}
            onClick={() => {
              list.first.reload();
              metrics.reload();
            }}
          />
        }
      />
      <section className="section">
        <div className="section__head">
          <h2 className="section__title">Точность ИИ</h2>
          <Segments<Period>
            label="Период"
            options={PERIODS}
            value={filters.period}
            onChange={(period) => set({ period })}
          />
        </div>
        {metrics.error !== undefined && (
          <Banner tone="danger">{loadErrorText(metrics.error)}</Banner>
        )}
        {metrics.data && <MetricsBlock metrics={metrics.data} />}
      </section>
      <div className="filters__group">
        <div className="filters">
          <SearchSelect
            compact
            label="Поставщик"
            value={supplier}
            empty="Все"
            placeholder="Название или БИН"
            search={supplierSearch}
            onChange={(choice) => {
              setSupplierLabel(choice);
              set({ supplierId: choice?.id });
            }}
          />
          <FilterSelect<PriceMatchAuditBucketId>
            label="Уверенность ИИ"
            value={filters.bucket}
            options={BUCKETS}
            onChange={(bucket) => set({ bucket })}
          />
        </div>
        <StatusChips<PriceMatchAuditStatus>
          label="Состояние строк"
          allLabel={null}
          value={filters.status}
          chips={STATUSES.map((entry) => ({ ...entry, count: counts?.[entry.value] }))}
          onChange={(status) => set({ status: status ?? "pending" })}
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
              icon="sparkles"
              title={
                filtered
                  ? "Ничего не нашлось"
                  : filters.status === "pending"
                    ? "Проверять пока нечего"
                    : "Проверенных строк нет"
              }
              text={
                filtered
                  ? "Измените отборы"
                  : "Строки попадают сюда, когда поставщик применил прайс, приняв позицию, предложенную ИИ"
              }
              action={
                filtered ? (
                  <Button
                    variant="secondary"
                    onClick={() => set({ supplierId: undefined, bucket: undefined })}
                  >
                    Сбросить фильтры
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <>
              <TableToolbar total={list.total} />
              <Table label="Аудит сопоставлений" columns={columns}>
                {rows.map((audit) => (
                  <AuditRow key={audit.id} audit={audit} />
                ))}
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

function MetricsBlock({ metrics }: { metrics: PriceMatchAuditMetrics }) {
  return (
    <div className="detail-stack">
      <dl className="kv">
        <dt>Проверено</dt>
        <dd>
          {metrics.checked.toLocaleString("ru-RU")}, верно {metrics.correct.toLocaleString("ru-RU")}{" "}
          — точность {percentText(metrics.accuracy)}
        </dd>
        <dt>Поставщики нажали «Верно»</dt>
        <dd>
          {metrics.proposals.accepted.toLocaleString("ru-RU")} из{" "}
          {metrics.proposals.proposed.toLocaleString("ru-RU")} предложений ИИ (
          {percentText(metrics.proposals.acceptedShare)})
        </dd>
        <dt>Порог уверенности сейчас</dt>
        <dd>
          {confidenceText(metrics.threshold)}{" "}
          <span className="kv__note">
            Меняется в{" "}
            <AppLink
              href={withQuery(routePaths.settings, { q: "price_match_confidence_threshold" })}
            >
              «Настройках»
            </AppLink>
          </span>
        </dd>
      </dl>
      <Table
        label="Точность по уверенности ИИ"
        columns={[
          { key: "bucket", header: "Уверенность ИИ" },
          { key: "checked", header: "Проверено", width: 140, numeric: true },
          { key: "correct", header: "Верно", width: 140, numeric: true },
          { key: "accuracy", header: "Точность", width: 140, numeric: true },
        ]}
      >
        {metrics.buckets.map((bucket) => (
          <tr key={bucket.bucket}>
            <td>{BUCKET_TEXT[bucket.bucket]}</td>
            <td className="num">{bucket.checked.toLocaleString("ru-RU")}</td>
            <td className="num">{bucket.correct.toLocaleString("ru-RU")}</td>
            <td className="num">{percentText(bucket.accuracy)}</td>
          </tr>
        ))}
      </Table>
    </div>
  );
}

function AuditRow({ audit }: { audit: AdminPriceMatchAudit }) {
  const href = matchAuditPath(audit.id);
  return (
    <tr {...rowLink(href)}>
      <td>
        <RowTitle
          href={href}
          sub={`Строка ${audit.import.rowNo.toLocaleString("ru-RU")}${
            audit.row.price !== null ? ` · ${audit.row.price.toLocaleString("ru-RU")} ₸` : ""
          }`}
        >
          <span className="clamp" title={auditRowTitle(audit.row)}>
            {auditRowTitle(audit.row)}
          </span>
        </RowTitle>
      </td>
      <td className="ac-text-body-s">
        <span className="clamp">{audit.aiItem?.name.text ?? "Позиции больше нет"}</span>
        {audit.aiItem && itemLine(audit.aiItem) && (
          <span className="ac-muted clamp">{itemLine(audit.aiItem)}</span>
        )}
      </td>
      <td className="num">{confidenceText(audit.aiConfidence)}</td>
      <td className="ac-text-body-s">
        <span className="clamp">{audit.supplier.name}</span>
      </td>
      <td className="ac-text-body-s nowrap">
        {audit.status === "pending"
          ? audit.acceptedAt
            ? formatMoment(audit.acceptedAt)
            : "—"
          : audit.decidedAt
            ? formatMoment(audit.decidedAt)
            : "—"}
      </td>
    </tr>
  );
}

/**
 * A row put aside (A-MOD-04): what the price list said, the item AI chose
 * with its confidence, explanation and model, who of the employees pressed
 * «Верно» and when, the offer it made; «Верно», and «Неверно…» with the
 * right item (a search: the article in any spelling or the name) or «Такой
 * позиции нет в справочнике», saying first what will happen.
 */
export function MatchAuditCard({ auditId }: { auditId: string }) {
  const toast = useToast();
  const online = useOnline();
  const card = useLoad<PriceMatchAuditCard>(
    () => apiClient.getPriceMatchAudit({ auditId }),
    `match-audit:${auditId}`,
  );
  const [wrongOpen, setWrongOpen] = useState(false);
  const [correctItem, setCorrectItem] = useState<Choice | null>(null);
  const [notInCatalog, setNotInCatalog] = useState(false);
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [historyKey, setHistoryKey] = useState(0);
  const audit = card.data?.audit;

  const itemSearch = useMemo(
    () =>
      async (query: string): Promise<Choice[]> => {
        const page = await apiClient.listAdminCatalogItems({
          query: { ...(query ? { q: query } : {}), status: "active", limit: SEARCH_PAGE },
        });
        return page.items
          .filter((item) => item.type !== "service" && item.id !== audit?.aiItem?.id)
          .map((item) => ({
            id: item.id,
            label: item.names.ru?.text ?? "Без названия",
            note: [item.brand?.name, item.article].filter(Boolean).join(" · ") || null,
          }));
      },
    [audit?.aiItem?.id],
  );

  const act = async (
    work: () => Promise<PriceMatchAuditCard>,
    done: (next: PriceMatchAuditCard) => string,
  ) => {
    setError(null);
    setBusy(true);
    try {
      const next = await work();
      toast.show(done(next));
      card.reload();
      setHistoryKey((value) => value + 1);
    } catch (thrown) {
      setError(auditErrorText(thrown));
    } finally {
      setBusy(false);
    }
  };

  const openWrong = () => {
    setCorrectItem(null);
    setNotInCatalog(false);
    setComment("");
    setWrongOpen(true);
  };

  const canWrong = notInCatalog || correctItem !== null;

  return (
    <>
      <Header
        crumbs={[CATALOG_CRUMB, MATCH_AUDIT_CRUMB]}
        title={audit ? auditRowTitle(audit.row) : "Строка прайса"}
        subtitle={
          audit && (
            <>
              <StatusBadge kind="matchAudit" status={audit.status}>
                {AUDIT_STATUS_TEXT[audit.status]}
              </StatusBadge>
              <AiBadge>предложено ИИ</AiBadge>
              {audit.decidedAt && (
                <span>
                  Проверено {formatMoment(audit.decidedAt)}
                  {audit.decidedBy?.name ? ` · ${audit.decidedBy.name}` : ""}
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
        {audit && card.data && (
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
            {audit.status === "wrong" && audit.result && (
              <Banner tone="warning">
                Неверно
                {audit.correctItem ? (
                  <>
                    , правильная позиция —{" "}
                    <AppLink href={catalogItemPath(audit.correctItem.id)}>
                      {audit.correctItem.name.text}
                    </AppLink>
                  </>
                ) : audit.notInCatalog ? (
                  ": такой позиции нет в справочнике"
                ) : null}
                . {wrongResultText(audit.result)} Поставщик видит исправление в «Модерации».
              </Banner>
            )}
            {audit.status === "correct" && (
              <Banner tone="neutral">Сопоставление верное: строка закрыта.</Banner>
            )}
            <section className="card">
              <h2 className="card__title">Строка прайса</h2>
              <dl className="kv">
                <dt>Артикул</dt>
                <dd>{audit.row.article ?? "—"}</dd>
                <dt>Бренд</dt>
                <dd>{audit.row.brand ?? "—"}</dd>
                <dt>Название</dt>
                <dd className="long-text">{audit.row.name ?? "—"}</dd>
                <dt>Цена</dt>
                <dd>
                  {audit.row.price !== null ? `${audit.row.price.toLocaleString("ru-RU")} ₸` : "—"}
                </dd>
                {audit.row.photoText && (
                  <>
                    <dt>На фото</dt>
                    <dd className="long-text">{audit.row.photoText}</dd>
                  </>
                )}
                <dt>Поставщик</dt>
                <dd>
                  <AppLink href={supplierPath(audit.supplier.id)}>{audit.supplier.name}</AppLink>
                </dd>
                <dt>Загрузка</dt>
                <dd>
                  {audit.import.fileName ?? "Прайс"}, строка{" "}
                  {audit.import.rowNo.toLocaleString("ru-RU")}
                  {audit.import.appliedAt && (
                    <span className="kv__note">
                      Применён {formatMoment(audit.import.appliedAt)}
                    </span>
                  )}
                </dd>
              </dl>
            </section>
            <section className="card">
              <h2 className="card__title">Предложил ИИ</h2>
              <dl className="kv">
                <dt>Позиция</dt>
                <dd>
                  {audit.aiItem ? (
                    <>
                      <AppLink href={catalogItemPath(audit.aiItem.id)}>
                        {audit.aiItem.name.text}
                      </AppLink>
                      {itemLine(audit.aiItem) && (
                        <span className="kv__note">
                          {itemLine(audit.aiItem)} · {audit.aiItem.category.name.text}
                        </span>
                      )}
                    </>
                  ) : (
                    "Позиции больше нет в справочнике"
                  )}
                </dd>
                <dt>Уверенность</dt>
                <dd>
                  {confidenceText(audit.aiConfidence)}
                  <span className="kv__note">{reasonText(audit.reason)}</span>
                </dd>
                <dt>Объяснение ИИ</dt>
                <dd className="long-text">{audit.aiExplanation ?? "—"}</dd>
                <dt>Модель</dt>
                <dd>{audit.aiModel ?? "—"}</dd>
                <dt>«Верно» нажал</dt>
                <dd>
                  {audit.acceptedBy?.name ?? "Сотрудник поставщика"}
                  {audit.acceptedAt && (
                    <span className="kv__note">{formatMoment(audit.acceptedAt)}</span>
                  )}
                </dd>
                {card.data.offer && (
                  <>
                    <dt>Предложение поставщика</dt>
                    <dd>
                      {card.data.offer.price.toLocaleString("ru-RU")} ₸ ·{" "}
                      {card.data.offer.status === "active" ? "в продаже" : "не в продаже"}
                      {card.data.offer.activeOrders > 0 && (
                        <span className="kv__note">
                          Активные заявки: {card.data.offer.activeOrders.toLocaleString("ru-RU")}
                        </span>
                      )}
                      {card.data.offer.editedByHand && (
                        <span className="kv__note">Правили вручную после загрузки</span>
                      )}
                    </dd>
                  </>
                )}
                {card.data.candidates.length > 0 && (
                  <>
                    <dt>Другие кандидаты</dt>
                    <dd>
                      {card.data.candidates.map((item) => (
                        <span key={item.id} className="kv__note">
                          <AppLink href={catalogItemPath(item.id)}>{item.name.text}</AppLink>
                          {itemLine(item) ? ` · ${itemLine(item)}` : ""}
                        </span>
                      ))}
                    </dd>
                  </>
                )}
              </dl>
            </section>
            {audit.status === "pending" && (
              <section className="card">
                <h2 className="card__title">Проверка</h2>
                <p className="section__note">
                  Сопоставление ИИ подтвердил поставщик. Верно ли, что строка прайса — эта позиция?
                </p>
                <ActionBar
                  label="Проверка сопоставления"
                  main={
                    <Button
                      disabled={!online || busy}
                      onClick={() =>
                        void act(
                          () =>
                            apiClient.markPriceMatchAuditCorrect(
                              { auditId },
                              { expectedVersion: audit.version },
                            ),
                          () => "Сопоставление верное",
                        )
                      }
                    >
                      Верно
                    </Button>
                  }
                  others={[
                    <Button
                      key="wrong"
                      variant="secondary"
                      destructive
                      disabled={!online || busy}
                      onClick={openWrong}
                    >
                      Неверно…
                    </Button>,
                  ]}
                />
              </section>
            )}
            <section className="section">
              <div className="section__head">
                <h2 className="section__title">История</h2>
              </div>
              <JournalHistory
                key={historyKey}
                filter={{ entityType: "price_match_audit", entityId: auditId }}
                loadKey={`match-audit-history:${auditId}:${String(historyKey)}`}
                caption="История проверки"
                empty="Записей пока нет"
              />
            </section>
          </div>
        )}
      </LoadingContent>
      <Dialog
        open={wrongOpen}
        onClose={() => setWrongOpen(false)}
        title="Сопоставление неверно?"
        actions={
          <>
            <Button
              disabled={!canWrong || busy}
              onClick={() => {
                setWrongOpen(false);
                if (!audit) return;
                void act(
                  () =>
                    apiClient.markPriceMatchAuditWrong(
                      { auditId },
                      {
                        expectedVersion: audit.version,
                        correctItemId: notInCatalog ? null : (correctItem?.id ?? null),
                        notInCatalog,
                        ...(comment.trim() ? { comment: comment.trim() } : {}),
                      },
                    ),
                  (next) =>
                    next.audit.result
                      ? wrongResultText(next.audit.result)
                      : "Сопоставление исправлено",
                );
              }}
            >
              Отметить неверным
            </Button>
            <Button variant="secondary" onClick={() => setWrongOpen(false)}>
              Отмена
            </Button>
          </>
        }
      >
        <div className="dialog-stack">
          <SearchSelect
            label="Правильная позиция"
            value={notInCatalog ? null : correctItem}
            onChange={(choice) => {
              setCorrectItem(choice);
              if (choice) setNotInCatalog(false);
            }}
            search={itemSearch}
            disabled={notInCatalog}
            placeholder="Артикул в любом написании или название"
          />
          <Checkbox
            label="Такой позиции нет в справочнике"
            checked={notInCatalog}
            onChange={(checked) => {
              setNotInCatalog(checked);
              if (checked) setCorrectItem(null);
            }}
          />
          <TextAreaField
            label="Комментарий"
            value={comment}
            onChange={setComment}
            hint="Не обязательно; виден только администраторам"
          />
          {card.data && (
            <ul className="section__note">
              {wrongConsequences(card.data).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
        </div>
      </Dialog>
    </>
  );
}
