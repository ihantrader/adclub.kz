import type {
  AdminModerationEntry,
  AdminModerationKind,
  AdminModerationPage,
} from "@adclub/contracts";
import {
  AiBadge,
  Banner,
  Button,
  Dialog,
  EmptyState,
  IconButton,
  LoadingContent,
  SkeletonList,
  TableToolbar,
  TextField,
  TypeMark,
  useToast,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useState } from "react";
import { apiClient } from "../api";
import {
  catalogErrorText,
  conflictText,
  isConflict,
  PHOTO_SOURCE_TEXT,
} from "../catalog/catalog-words";
import { whoChanged } from "../catalog/shared";
import { usePagedList } from "../catalog/paged";
import { loadErrorText } from "../errors";
import { formatMoment } from "../format";
import { StatusChips } from "../layout/filters";
import { Header, RowTitle, rowLink, Table, Thumb } from "../layout/layout";
import { navigateTo, routePaths, supplierPath, useLocation, withQuery } from "../router";
import { SearchSelect } from "../search-select/SearchSelect";
import type { Choice } from "../search-select/search-select-core";
import { createChoiceSources } from "../search-select/sources";
import {
  entryHref,
  entrySub,
  entryTitle,
  KIND_TEXT,
  moderationFiltersOf,
  photoOrigin,
  SOURCE_TEXT,
  sourceHost,
  type ModerationFilters,
} from "./moderation-words";

const PAGE = 50;

const supplierSearch = createChoiceSources(apiClient).suppliers();

const COLUMNS = [
  { key: "kind", header: "Вид", width: 130 },
  { key: "what", header: "Что предложено" },
  { key: "supplier", header: "Поставщик", width: 220 },
  { key: "source", header: "Откуда", width: 120 },
  { key: "when", header: "Когда", width: 150 },
];

function linkOf(filters: ModerationFilters): string {
  return withQuery(routePaths.moderation, { kind: filters.kind, supplierId: filters.supplierId });
}

/**
 * «Модерация» (TASK-071; SCREENS A-HOME, A-MOD-01, A-MOD-02): everything
 * suppliers wait for, in one table — requests to add an item (from a price
 * list or by hand) and compatibility proposals — oldest first, by kind and
 * supplier, «Всего N» and «Показать ещё». A row opens its own card: the
 * request, or the item's «Совместимость»; the decisions are made there. The
 * home card «Модерация ждёт · N» is this list's «Всего» with no filter.
 * «Запросы на позиции» and «Предложения совместимости» of «Справочник» keep
 * the history and the decided ones.
 */
export function Moderation() {
  const location = useLocation();
  const filters = moderationFiltersOf(location.query);
  const key = JSON.stringify(filters);
  const list = usePagedList<
    AdminModerationEntry,
    AdminModerationPage & { items: AdminModerationEntry[] }
  >(async (cursor) => {
    const page = await apiClient.listAdminModeration({
      query: {
        limit: PAGE,
        ...(filters.kind ? { kind: filters.kind } : {}),
        ...(filters.supplierId ? { supplierId: filters.supplierId } : {}),
        ...(cursor ? { cursor } : {}),
      },
    });
    return { ...page, items: page.entries };
  }, `moderation:${key}`);
  const [supplierLabel, setSupplierLabel] = useState<Choice | null>(null);
  const toast = useToast();
  const online = useOnline();
  const [deciding, setDeciding] = useState<string | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<AdminModerationEntry | null>(null);
  const [reason, setReason] = useState("");

  // «Подтвердить» / «Отклонить» of a photo: the very decision of the item's «Фото» (A-MOD-03).
  const decide = async (entry: AdminModerationEntry, approve: boolean, why?: string) => {
    const photo = entry.photo;
    if (!photo) return;
    setDecisionError(null);
    setDeciding(entry.id);
    try {
      await apiClient.setItemPhotoStatus(
        { itemId: photo.itemId, photoId: photo.id },
        {
          expectedVersion: photo.version,
          status: approve ? "approved" : "rejected",
          ...(why ? { reason: why } : {}),
        },
      );
      toast.show(approve ? "Фото подтверждено" : "Фото отклонено");
    } catch (thrown) {
      setDecisionError(
        isConflict(thrown)
          ? conflictText(await whoChanged("catalog_item_photo", photo.id))
          : catalogErrorText(thrown),
      );
    } finally {
      setDeciding(null);
      list.first.reload();
    }
  };
  const rows = list.items;
  const set = (patch: Partial<ModerationFilters>) =>
    navigateTo(linkOf({ ...filters, ...patch }), { replace: true });
  const filtered = Boolean(filters.kind || filters.supplierId);
  const supplierOfRows = rows.find((row) => row.supplier?.id === filters.supplierId)?.supplier;
  const supplier: Choice | null = !filters.supplierId
    ? null
    : supplierLabel?.id === filters.supplierId
      ? supplierLabel
      : { id: filters.supplierId, label: supplierOfRows?.name ?? "Выбранный поставщик" };

  return (
    <>
      <Header
        title="Модерация"
        actions={
          <IconButton icon="refresh" label="Обновить" size={20} onClick={list.first.reload} />
        }
      />
      <p className="section__note">
        Ждут решения администратора. Фото подтверждаются и отклоняются прямо здесь; запросы и
        совместимость — в карточке запроса или во вкладке «Совместимость» позиции; решённые остаются
        в «Справочнике».
      </p>
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
        </div>
        <StatusChips<AdminModerationKind>
          label="Вид запросов"
          value={filters.kind}
          chips={(Object.keys(KIND_TEXT) as AdminModerationKind[]).map((kind) => ({
            value: kind,
            label: KIND_TEXT[kind],
            count: null,
          }))}
          onChange={(kind) => set({ kind: kind ?? undefined })}
        />
      </div>
      {decisionError && <Banner tone="warning">{decisionError}</Banner>}
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
              icon="checklist"
              title={filtered ? "Ничего не нашлось" : "Модерация ничего не ждёт"}
              text={
                filtered
                  ? "Измените отборы"
                  : "Здесь появятся запросы поставщиков на новые позиции и их предложения совместимости"
              }
              action={
                filtered ? (
                  <Button
                    variant="secondary"
                    onClick={() => navigateTo(linkOf({}), { replace: true })}
                  >
                    Сбросить фильтры
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <>
              <TableToolbar total={list.total} />
              <Table label="Модерация" columns={COLUMNS}>
                {rows.map((entry) => {
                  const href = entryHref(entry);
                  return (
                    <tr key={`${entry.kind}:${entry.id}`} {...rowLink(href)}>
                      <td className="ac-text-body-s nowrap">{KIND_TEXT[entry.kind]}</td>
                      <td>
                        {entry.kind === "photo" && entry.photo ? (
                          <div className="moderation-photo">
                            <a
                              href={entry.photo.originalUrl ?? entry.photo.thumbUrl ?? undefined}
                              target="_blank"
                              rel="noreferrer noopener"
                              aria-label="Открыть фото полностью"
                            >
                              <Thumb src={entry.photo.thumbUrl} size={72} alt="Фото позиции" />
                            </a>
                            <div className="moderation-photo__about">
                              <RowTitle href={href} sub={entrySub(entry) ?? undefined}>
                                <span className="clamp" title={entryTitle(entry)}>
                                  {entryTitle(entry)}
                                </span>
                              </RowTitle>
                              <span className="badges">
                                {photoOrigin(entry) === "ai" ? (
                                  <AiBadge>AI</AiBadge>
                                ) : (
                                  <span className="ac-text-caption ac-muted">
                                    {photoOrigin(entry)}
                                  </span>
                                )}
                                <TypeMark icon={entry.photo.sourceUrl ? "externalLink" : "upload"}>
                                  {PHOTO_SOURCE_TEXT[entry.photo.sourceType]}
                                </TypeMark>
                                {entry.photo.sourceUrl && (
                                  <a
                                    className="ac-text-caption"
                                    href={entry.photo.sourceUrl}
                                    target="_blank"
                                    rel="noreferrer noopener"
                                    title={entry.photo.sourceUrl}
                                  >
                                    {sourceHost(entry.photo.sourceUrl)}
                                  </a>
                                )}
                              </span>
                              <span className="row-actions">
                                <Button
                                  variant="secondary"
                                  size="s"
                                  disabled={!online || deciding !== null}
                                  loading={deciding === entry.id}
                                  onClick={() => void decide(entry, true)}
                                >
                                  Подтвердить
                                </Button>
                                <Button
                                  variant="text"
                                  size="s"
                                  disabled={!online || deciding !== null}
                                  onClick={() => {
                                    setReason("");
                                    setRejecting(entry);
                                  }}
                                >
                                  Отклонить…
                                </Button>
                              </span>
                            </div>
                          </div>
                        ) : (
                          <RowTitle href={href} sub={entrySub(entry) ?? undefined}>
                            <span className="clamp" title={entryTitle(entry)}>
                              {entryTitle(entry)}
                            </span>
                          </RowTitle>
                        )}
                      </td>
                      <td className="ac-text-body-s">
                        {entry.supplier ? (
                          <a
                            href={supplierPath(entry.supplier.id)}
                            className="clamp"
                            onClick={(event) => {
                              event.preventDefault();
                              navigateTo(supplierPath(entry.supplier!.id));
                            }}
                          >
                            {entry.supplier.name}
                          </a>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="ac-text-body-s nowrap">{SOURCE_TEXT[entry.source]}</td>
                      <td className="ac-text-body-s nowrap">{formatMoment(entry.createdAt)}</td>
                    </tr>
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
      <Dialog
        open={rejecting !== null}
        onClose={() => setRejecting(null)}
        title="Отклонить фото?"
        actions={
          <>
            <Button
              disabled={!reason.trim()}
              onClick={async () => {
                const entry = rejecting;
                setRejecting(null);
                if (entry) await decide(entry, false, reason.trim());
              }}
            >
              Отклонить
            </Button>
            <Button variant="secondary" onClick={() => setRejecting(null)}>
              Отмена
            </Button>
          </>
        }
      >
        <div className="dialog-stack">
          <TextField label="Причина" value={reason} onChange={setReason} hint="Обязательна" />
          {rejecting?.photo?.proposedBy === "supplier" && (
            <p className="ac-text-body-s">Поставщик увидит причину в разделе «Модерация».</p>
          )}
        </div>
      </Dialog>
    </>
  );
}
