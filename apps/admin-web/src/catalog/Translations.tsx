import type {
  TranslationQueueItem,
  TranslationQueuePage,
  TranslationTargetLanguage,
} from "@adclub/contracts";
import {
  AiBadge,
  Banner,
  Button,
  Dialog,
  EmptyState,
  IconButton,
  LoadingContent,
  MenuButton,
  SkeletonList,
  TableToolbar,
  TextField,
  TypeMark,
  useToast,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useState } from "react";
import { apiClient } from "../api";
import { loadErrorText } from "../errors";
import { formatMoment } from "../format";
import { FilterSelect, StatusChips } from "../layout/filters";
import { Header, RowTitle, Table } from "../layout/layout";
import { navigateTo, useLocation } from "../router";
import { catalogErrorText } from "./catalog-words";
import { usePagedList } from "./paged";
import { catalogTabs } from "./shared";
import {
  languageText,
  objectLink,
  reasonText,
  rowActions,
  TRANSLATION_KINDS,
  TRANSLATION_LANGUAGES,
  TRANSLATION_STATES,
  translationFiltersOf,
  translationKindText,
  translationsCount,
  translationsLink,
  type TranslationFilters,
} from "./translation-words";

const PAGE = 50;

const COLUMNS = [
  { key: "what", header: "Что переводится" },
  { key: "lang", header: "Язык", width: 120 },
  { key: "source", header: "Русский текст", width: 220 },
  { key: "current", header: "Перевод сейчас", width: 220 },
  { key: "why", header: "Причина и когда", width: 220 },
  { key: "actions", header: "Действия", actions: true, hiddenHeader: true, width: 190 },
];

const EMPTY_TEXT: Record<TranslationFilters["state"], { title: string; text: string }> = {
  failed: {
    title: "Отказанных переводов нет",
    text: "Сюда попадает перевод, который не прошёл проверку: пустой, длиннее поля, не на том языке или совпал с соседом",
  },
  outdated: {
    title: "Устаревших переводов нет",
    text: "Сюда попадает перевод, русский текст которого изменился после него, — обычно исправленный вручную",
  },
  queued: {
    title: "Ничего не ждёт перевода",
    text: "Новые и изменённые русские тексты переводит ИИ в фоне — сначала категории и характеристики, затем позиции в продаже",
  },
  missing: {
    title: "Все тексты переведены или ждут перевода",
    text: "Сюда попадает язык без перевода, который никто не просил: очищенный вручную или из времени до автоперевода",
  },
};

interface Editing {
  item: TranslationQueueItem;
  text: string;
}

/**
 * «Справочник → Переводы» (TASK-054; SCREENS A-CAT-05): the translations of
 * the whole catalog by state — «Отказано» first — with the server's counts
 * under the kind and language filters of the address. A row says what is
 * translated, into what, from what Russian text, what the language holds
 * now and why the row is here; it opens its object and has the same
 * actions as the tab «Переводы» of an item. «Перевести заново все
 * отказанные» — one action with its number and a confirmation.
 */
export function Translations() {
  const toast = useToast();
  const online = useOnline();
  const location = useLocation();
  const filters = translationFiltersOf(location.query);
  const key = JSON.stringify(filters);
  const list = usePagedList<TranslationQueueItem, TranslationQueuePage>(
    (cursor) =>
      apiClient.listTranslationQueue({
        query: {
          state: filters.state,
          limit: PAGE,
          ...(filters.entityType ? { entityType: filters.entityType } : {}),
          ...(filters.lang ? { lang: filters.lang } : {}),
          ...(cursor ? { cursor } : {}),
        },
      }),
    `translations:${key}`,
  );
  const counts = list.first.data?.counts;
  const failed = counts?.failed ?? 0;
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [retryAll, setRetryAll] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const set = (patch: Partial<TranslationFilters>) =>
    navigateTo(translationsLink({ ...filters, ...patch }), { replace: true });
  const filtered = Boolean(filters.entityType || filters.lang);

  const target = (item: TranslationQueueItem) => ({
    entityType: item.entityType,
    entityId: item.entityId,
    field: item.field,
    lang: item.lang,
  });

  const act = async (action: () => Promise<unknown>, done: string) => {
    setError(null);
    try {
      await action();
      toast.show(done);
    } catch (thrown) {
      setError(catalogErrorText(thrown));
    }
    // A colleague may have changed it meanwhile: the list shows what is true now.
    list.first.reload();
  };

  const saveEdit = async () => {
    if (!editing) return;
    setDialogError(null);
    setSaving(true);
    try {
      await apiClient.editTranslation(target(editing.item), { text: editing.text.trim() });
      setEditing(null);
      toast.show("Перевод сохранён вручную");
      list.first.reload();
    } catch (thrown) {
      setDialogError(catalogErrorText(thrown));
    } finally {
      setSaving(false);
    }
  };

  const confirmRetryAll = async () => {
    setRetrying(true);
    setError(null);
    try {
      const result = await apiClient.retryFailedTranslations({
        ...(filters.entityType ? { entityType: filters.entityType } : {}),
        ...(filters.lang ? { lang: filters.lang } : {}),
      });
      setRetryAll(false);
      toast.show(
        result.requeued > 0
          ? `В очередь поставлено: ${translationsCount(result.requeued)}`
          : "Отказанных переводов уже нет",
      );
    } catch (thrown) {
      setRetryAll(false);
      setError(catalogErrorText(thrown));
    } finally {
      setRetrying(false);
      list.first.reload();
    }
  };

  return (
    <>
      <Header
        title="Справочник"
        tabs={catalogTabs("translations")}
        actions={
          <IconButton icon="refresh" label="Обновить" size={20} onClick={list.first.reload} />
        }
      />
      <div className="filters__group">
        <div className="filters">
          <FilterSelect
            label="Что переводится"
            value={filters.entityType}
            options={TRANSLATION_KINDS}
            onChange={(entityType) => set({ entityType })}
          />
          <FilterSelect<TranslationTargetLanguage>
            label="Язык"
            value={filters.lang}
            options={TRANSLATION_LANGUAGES}
            onChange={(lang) => set({ lang })}
          />
          {filters.state === "failed" && failed > 0 && (
            <Button
              variant="secondary"
              size="s"
              icon="refresh"
              disabled={!online}
              onClick={() => setRetryAll(true)}
            >
              Перевести заново все отказанные
            </Button>
          )}
        </div>
        <StatusChips
          label="Состояние переводов"
          allLabel={null}
          value={filters.state}
          chips={TRANSLATION_STATES.map((entry) => ({ ...entry, count: counts?.[entry.value] }))}
          onChange={(state) => set({ state: state ?? "failed" })}
        />
      </div>
      {error && <Banner tone="warning">{error}</Banner>}
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
          {list.first.data !== undefined ? ". Показаны прежние данные." : ""}
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
          {list.items.length === 0 ? (
            <EmptyState
              icon="language"
              title={filtered ? "Ничего не нашлось" : EMPTY_TEXT[filters.state].title}
              text={filtered ? "Измените отборы" : EMPTY_TEXT[filters.state].text}
              action={
                filtered ? (
                  <Button
                    variant="secondary"
                    onClick={() => set({ entityType: undefined, lang: undefined })}
                  >
                    Сбросить фильтры
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <>
              <TableToolbar total={list.total}>
                {filtered && (
                  <Button
                    variant="text"
                    size="s"
                    onClick={() => set({ entityType: undefined, lang: undefined })}
                  >
                    Сбросить фильтры
                  </Button>
                )}
              </TableToolbar>
              <Table label="Переводы справочника" columns={COLUMNS} className="cat-translations">
                {list.items.map((item) => (
                  <TranslationRow
                    key={`${item.entityType}:${item.entityId}:${item.field}:${item.lang}`}
                    item={item}
                    online={online}
                    onEdit={() => {
                      setDialogError(null);
                      setEditing({ item, text: item.currentText ?? "" });
                    }}
                    onRetranslate={() =>
                      void act(
                        () => apiClient.retranslate(target(item)),
                        "Перевод поставлен в очередь",
                      )
                    }
                    onKeep={() =>
                      void act(
                        () =>
                          apiClient.editTranslation(target(item), { text: item.currentText ?? "" }),
                        "Перевод оставлен как есть",
                      )
                    }
                    onRelease={() =>
                      void act(
                        () => apiClient.releaseTranslation(target(item)),
                        "Ручная правка снята, язык снова переводит ИИ",
                      )
                    }
                  />
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
      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={
          editing
            ? `${editing.item.entityName}: ${languageText(editing.item.lang).toLowerCase()}`
            : ""
        }
        actions={
          <>
            <Button onClick={saveEdit} disabled={!editing?.text.trim()} loading={saving}>
              Сохранить
            </Button>
            <Button variant="secondary" onClick={() => setEditing(null)}>
              Отмена
            </Button>
          </>
        }
      >
        {editing && (
          <div className="dialog-stack">
            <p className="ac-text-body-s">
              Русский текст: <span className="long-text">{editing.item.sourceText}</span>
            </p>
            <TextField
              label="Текст"
              value={editing.text}
              onChange={(text) => setEditing({ ...editing, text })}
              error={dialogError ?? undefined}
            />
            <p className="ac-text-body-s ac-muted">
              Текст станет ручным: автоперевод его не затрёт. Когда изменится русский текст, перевод
              появится на вкладке «Устарело».
            </p>
          </div>
        )}
      </Dialog>
      <Dialog
        open={retryAll}
        onClose={() => setRetryAll(false)}
        title="Перевести заново все отказанные?"
        actions={
          <>
            <Button onClick={() => void confirmRetryAll()} loading={retrying} disabled={!online}>
              Перевести заново
            </Button>
            <Button variant="secondary" onClick={() => setRetryAll(false)}>
              Отмена
            </Button>
          </>
        }
      >
        <p className="ac-text-body">
          {translationsCount(failed)}
          {filters.entityType || filters.lang ? " по выбранным отборам" : ""} снова встанут в
          очередь, ИИ переведёт их в фоне. Переводы, исправленные вручную, не затрагиваются.
        </p>
      </Dialog>
    </>
  );
}

function TranslationRow({
  item,
  online,
  onEdit,
  onRetranslate,
  onKeep,
  onRelease,
}: {
  item: TranslationQueueItem;
  online: boolean;
  onEdit: () => void;
  onRetranslate: () => void;
  onKeep: () => void;
  onRelease: () => void;
}) {
  const href = objectLink(item);
  const actions = rowActions(item);
  const reason = reasonText(item);
  const menu = [
    ...(actions.retranslate
      ? [
          {
            key: "retranslate",
            label: "Перевести заново",
            icon: "refresh" as const,
            disabled: !online,
            onSelect: onRetranslate,
          },
        ]
      : []),
    ...(actions.release
      ? [
          {
            key: "release",
            label: "Снять ручную правку",
            icon: "sparkles" as const,
            disabled: !online,
            onSelect: onRelease,
          },
        ]
      : []),
  ];
  return (
    <tr>
      <td>
        {href ? (
          <RowTitle href={href} sub={translationKindText(item)}>
            <span className="clamp" title={item.entityName}>
              {item.entityName}
            </span>
          </RowTitle>
        ) : (
          <span className="row-title">
            <span className="clamp">{item.entityName}</span>
            <span className="row-title__sub">{translationKindText(item)}</span>
          </span>
        )}
      </td>
      <td className="nowrap">{languageText(item.lang)}</td>
      <td>
        <span className="clamp" title={item.sourceText}>
          {item.sourceText}
        </span>
      </td>
      <td>
        <div className="cell-stack">
          {item.currentText ? (
            <span className="clamp" title={item.currentText}>
              {item.currentText}
            </span>
          ) : (
            <span className="ac-muted">Нет текста</span>
          )}
          {item.currentOrigin === "manual" && <TypeMark icon="user">Вручную</TypeMark>}
          {item.currentOrigin === "ai" && <AiBadge>ИИ</AiBadge>}
        </div>
      </td>
      <td>
        <div className="cell-stack">
          {reason && (
            <span className={item.state === "failed" ? "warning-text" : undefined}>{reason}</span>
          )}
          <span className="ac-text-caption ac-muted nowrap">{formatMoment(item.updatedAt)}</span>
        </div>
      </td>
      <td className="admin-table__actions">
        <span className="row-actions">
          {actions.keep ? (
            <Button variant="secondary" size="s" disabled={!online} onClick={onKeep}>
              Оставить как есть
            </Button>
          ) : null}
          <Button variant="secondary" size="s" disabled={!online} onClick={onEdit}>
            Исправить
          </Button>
          {menu.length > 0 && (
            <MenuButton size="s" label={`Перевод: ${item.entityName}`} actions={menu} />
          )}
        </span>
      </td>
    </tr>
  );
}
