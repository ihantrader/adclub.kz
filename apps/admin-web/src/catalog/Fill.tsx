import { isApiError } from "@adclub/api-client";
import {
  catalogValuesRejectedDetailsSchema,
  type AdminAttribute,
  type AttributeValue,
  type CategoryFillPage,
  type CategoryFillRow,
} from "@adclub/contracts";
import {
  ActionBar,
  Banner,
  Button,
  Chip,
  EmptyState,
  IconButton,
  LoadingContent,
  Select,
  SkeletonList,
  TableToolbar,
  TextField,
  useToast,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useState, type ReactNode } from "react";
import { apiClient } from "../api";
import { loadErrorText } from "../errors";
import { FilterSelect } from "../layout/filters";
import { Header, RowTitle } from "../layout/layout";
import { catalogItemPath, navigateTo, routePaths, useLocation, withQuery } from "../router";
import { useLoad } from "../use-load";
import { catalogErrorText } from "./catalog-words";
import {
  cellErrors,
  cellKey,
  fillCells,
  rowValue,
  withEdit,
  type CellEdit,
  type CellError,
  type CellKey,
} from "./fill-state";
import { CATALOG_CRUMB } from "./shared";
import { numberHint, parseValue, ruText, valueInput, valueText } from "./values";

const PAGE = 50;

interface Draft {
  raw: string;
  /** The value the edit is made against: as read, or as stored after a conflict. */
  previous: AttributeValue;
}

/**
 * A-CAT-03 «Дозаполнение» (SCREENS 7.2; TASK-035, TASK-080): the items of a
 * subcategory × its active characteristics, a page at a time (thousands of
 * items never load at once), «Только пустые» by the chosen characteristic,
 * an editor in the cell by type, an empty one «Не заполнено». The edits wait
 * in a panel that stays at the bottom («Изменено N · Сохранить»); saving is
 * one request, all or nothing: refused cells show why, a colleague's change
 * shows the value stored now, and every typed value stays.
 */
export function Fill({ categoryId }: { categoryId: string }) {
  const toast = useToast();
  const online = useOnline();
  const { query } = useLocation();
  const attributeId = query.get("attribute");
  const onlyEmpty = query.get("empty") === "1" && attributeId !== null;
  const key = `${categoryId}:${onlyEmpty ? attributeId : ""}`;
  const request = (cursor?: string) =>
    apiClient.getCategoryFill(
      { categoryId },
      {
        query: {
          limit: PAGE,
          cursor,
          ...(onlyEmpty && attributeId ? { emptyAttributeId: attributeId } : {}),
        },
      },
    );
  const first = useLoad<CategoryFillPage>(() => request(), key);
  const [more, setMore] = useState<{ key: string; rows: CategoryFillRow[]; next: string | null }>({
    key: "",
    rows: [],
    next: null,
  });
  const [saved, setSaved] = useState<Map<string, CategoryFillRow>>(new Map());
  const [drafts, setDrafts] = useState<Map<CellKey, Draft>>(new Map());
  const [errors, setErrors] = useState<Map<CellKey, CellError>>(new Map());
  const [banner, setBanner] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const extra = more.key === key ? more : { key, rows: [], next: null };
  const page = first.data;
  const attributes = page?.attributes ?? [];
  const rows = [...(page?.rows ?? []), ...extra.rows].map((row) => saved.get(row.item.id) ?? row);
  const next = extra.rows.length > 0 ? extra.next : (page?.nextCursor ?? null);

  const setFilter = (values: { attribute?: string | null; empty?: boolean }) => {
    navigateTo(
      withQuery(`/catalog/fill/${categoryId}`, {
        attribute: values.attribute === undefined ? attributeId : values.attribute,
        empty: (values.empty ?? onlyEmpty) ? "1" : null,
      }),
      { replace: true },
    );
  };

  const loadMore = async () => {
    if (!next) return;
    setLoadingMore(true);
    try {
      const nextPage = await request(next);
      setMore({ key, rows: [...extra.rows, ...nextPage.rows], next: nextPage.nextCursor });
    } catch (thrown) {
      setBanner(loadErrorText(thrown));
    } finally {
      setLoadingMore(false);
    }
  };

  const edit = (row: CategoryFillRow, attribute: AdminAttribute, raw: string) => {
    const cell = cellKey(row.item.id, attribute.id);
    const nextDrafts = new Map(drafts);
    const previous = drafts.get(cell)?.previous ?? rowValue(row, attribute.id);
    nextDrafts.set(cell, { raw, previous });
    setDrafts(nextDrafts);
    if (errors.has(cell)) {
      const nextErrors = new Map(errors);
      nextErrors.delete(cell);
      setErrors(nextErrors);
    }
  };

  /** The edits that really change something, and the cells the typed text can't be. */
  const pending = () => {
    let edits = new Map<CellKey, CellEdit>();
    const invalid = new Map<CellKey, CellError>();
    for (const [cell, draft] of drafts) {
      const [itemId, attrId] = cell.split(":") as [string, string];
      const attribute = attributes.find((entry) => entry.id === attrId);
      if (!attribute) continue;
      const parsed = parseValue(attribute, draft.raw);
      if ("error" in parsed) {
        invalid.set(cell, { message: parsed.error });
        continue;
      }
      edits = withEdit(edits, {
        itemId,
        attributeId: attrId,
        previous: draft.previous,
        value: parsed.value,
      });
    }
    return { edits, invalid };
  };
  const { edits: currentEdits, invalid: currentInvalid } = pending();
  const changedCount = currentEdits.size + currentInvalid.size;

  const discard = () => {
    setDrafts(new Map());
    setErrors(new Map());
    setBanner(null);
  };

  const save = async () => {
    const { edits, invalid } = pending();
    if (invalid.size > 0) {
      setErrors(invalid);
      setBanner("Исправьте отмеченные ячейки");
      return;
    }
    const cells = fillCells(edits);
    if (cells.length === 0) return;
    setBanner(null);
    setSaving(true);
    try {
      const response = await apiClient.fillCategory({ categoryId }, { cells });
      const nextSaved = new Map(saved);
      for (const row of response.rows) nextSaved.set(row.item.id, row);
      setSaved(nextSaved);
      setDrafts(new Map());
      setErrors(new Map());
      toast.show(`Сохранено ячеек: ${response.changedCells}`);
    } catch (thrown) {
      if (isApiError(thrown) && thrown.code === "CATALOG_VALUES_REJECTED") {
        const details = catalogValuesRejectedDetailsSchema.safeParse(thrown.details);
        const placed = cellErrors(cells, details.success ? details.data.rejections : []);
        setErrors(placed);
        // A conflict shows what is stored now; the typed value is kept and,
        // saved again, replaces it.
        const rebased = new Map(drafts);
        for (const [cell, error] of placed) {
          const draft = rebased.get(cell);
          if (draft && error.current !== undefined)
            rebased.set(cell, { ...draft, previous: error.current });
        }
        setDrafts(rebased);
        setBanner(
          [...placed.values()].some((error) => error.current !== undefined)
            ? "Ничего не сохранено: часть значений уже изменили — видно у ячеек. Проверьте и сохраните ещё раз"
            : "Ничего не сохранено: ошибки — у ячеек",
        );
      } else {
        setBanner(catalogErrorText(thrown));
      }
    } finally {
      setSaving(false);
    }
  };

  const category = page?.category;
  const categoryName = category ? ruText(category.names) : null;
  const total = page?.total ?? 0;
  return (
    <>
      <Header
        crumbs={[
          CATALOG_CRUMB,
          {
            label: categoryName ?? "Подкатегория",
            href: withQuery(routePaths.catalog, { node: categoryId }),
          },
        ]}
        title="Дозаполнение"
        actions={<IconButton icon="refresh" label="Обновить" size={20} onClick={first.reload} />}
      />
      <div className="filters">
        <FilterSelect
          label="Характеристика"
          value={attributeId}
          options={attributes.map((attribute) => ({
            value: attribute.id,
            label: ruText(attribute.names),
          }))}
          onChange={(attribute) => setFilter({ attribute: attribute ?? null, empty: false })}
        />
        <div className="cat-fill-flag">
          <Chip
            selected={onlyEmpty}
            disabled={!attributeId}
            onClick={() => setFilter({ empty: !onlyEmpty })}
          >
            Только пустые
          </Chip>
          {!attributeId && (
            <span className="cat-fill-flag__hint">Сначала выберите характеристику</span>
          )}
        </div>
      </div>
      {banner && <Banner tone="warning">{banner}</Banner>}
      {first.error !== undefined && (
        <Banner
          tone="danger"
          action={
            <Button variant="text" size="s" onClick={first.reload}>
              Повторить
            </Button>
          }
        >
          {loadErrorText(first.error)}
        </Banner>
      )}
      <LoadingContent
        ready={page !== undefined}
        indicator={first.indicator}
        label="Загрузка"
        swapKey={first.answerKey}
        skeleton={<SkeletonList rows={6} label="Загрузка" />}
      >
        <div className="list-block">
          {attributes.length > 0 && rows.length > 0 && (
            <TableToolbar total={total}>
              {onlyEmpty && (
                <Button variant="text" size="s" onClick={() => setFilter({ empty: false })}>
                  Сбросить фильтры
                </Button>
              )}
            </TableToolbar>
          )}
          {attributes.length === 0 ? (
            <EmptyState
              icon="checklist"
              title="У подкатегории нет активных характеристик"
              text="Добавьте характеристику в разделе «Категории» — тогда здесь появится таблица."
            />
          ) : rows.length === 0 ? (
            <EmptyState
              icon="circleCheck"
              title={onlyEmpty ? "Пустых значений нет" : "В подкатегории нет позиций"}
              text={onlyEmpty ? "У всех позиций эта характеристика заполнена" : undefined}
            />
          ) : (
            <div className="table-wrap">
              <table
                className="admin-table admin-table--fixed cat-fill-table"
                style={{ minWidth: 280 + attributes.length * 200 }}
              >
                <caption className="ac-visually-hidden">Значения характеристик позиций</caption>
                <colgroup>
                  <col style={{ width: 280 }} />
                  {attributes.map((attribute) => (
                    <col key={attribute.id} style={{ width: 200 }} />
                  ))}
                </colgroup>
                <thead>
                  <tr>
                    <th scope="col">Позиция</th>
                    {attributes.map((attribute) => (
                      <th
                        key={attribute.id}
                        scope="col"
                        className={
                          attribute.id === attributeId ? "cat-fill-table__col--on" : undefined
                        }
                        title={numberHint(attribute) ?? undefined}
                      >
                        <span className="cat-fill-table__head">
                          {ruText(attribute.names)}
                          {attribute.isRequiredForComplete && (
                            <span className="cat-required" title="Участвует в полноте">
                              {" "}
                              *
                            </span>
                          )}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.item.id}>
                      <td>
                        <RowTitle
                          href={catalogItemPath(row.item.id)}
                          sub={
                            [row.item.brand?.name, row.item.article].filter(Boolean).join(" · ") ||
                            undefined
                          }
                        >
                          <span className="clamp" title={ruText(row.item.names)}>
                            {ruText(row.item.names)}
                          </span>
                        </RowTitle>
                      </td>
                      {attributes.map((attribute) => {
                        const cell = cellKey(row.item.id, attribute.id);
                        const draft = drafts.get(cell);
                        const error = errors.get(cell);
                        const stored = rowValue(row, attribute.id);
                        return (
                          <td
                            key={attribute.id}
                            className={currentEdits.has(cell) ? "cat-cell--changed" : undefined}
                          >
                            <CellEditor
                              attribute={attribute}
                              raw={draft ? draft.raw : valueInput(stored)}
                              label={`${ruText(attribute.names)}: ${ruText(row.item.names)}`}
                              disabled={!online}
                              error={
                                error
                                  ? `${error.message}${
                                      error.current !== undefined
                                        ? `. Сейчас: ${valueText(attribute, error.current)}`
                                        : ""
                                    }`
                                  : undefined
                              }
                              onChange={(raw) => edit(row, attribute, raw)}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {next && (
            <Button variant="secondary" size="s" onClick={loadMore} loading={loadingMore}>
              Показать ещё
            </Button>
          )}
          {attributes.some((attribute) => attribute.isRequiredForComplete) && rows.length > 0 && (
            <p className="ac-text-caption ac-muted">* — участвует в полноте позиции</p>
          )}
        </div>
      </LoadingContent>

      {changedCount > 0 && (
        <SaveBar
          note={`Изменено ячеек: ${String(changedCount)}`}
          saving={saving}
          disabled={!online}
          onSave={save}
          onDiscard={discard}
        />
      )}
    </>
  );
}

/**
 * The panel of unsaved edits that stays at the bottom of the window while
 * the table scrolls (TASK-080): what is changed, «Сохранить» and «Отменить
 * правки» — the actions laid out by `ActionBar`.
 */
export function SaveBar({
  note,
  saving,
  disabled,
  onSave,
  onDiscard,
}: {
  note: ReactNode;
  saving: boolean;
  disabled?: boolean;
  onSave: () => void;
  onDiscard: () => void;
}) {
  return (
    <div className="cat-save-bar" role="region" aria-label="Несохранённые правки">
      <span className="cat-save-bar__note">{note}</span>
      <ActionBar
        compact
        label="Сохранение правок"
        main={
          <Button disabled={disabled} loading={saving} onClick={onSave}>
            Сохранить
          </Button>
        }
        others={[
          <Button key="discard" variant="text" disabled={saving} onClick={onDiscard}>
            Отменить правки
          </Button>,
        ]}
      />
    </div>
  );
}

/** «Не заполнено»: the empty entry of a list — chosen, it clears the value. */
const EMPTY_CHOICE = "__empty";

/**
 * An editor of one value by its type (shared with the item's
 * characteristics): our compact 40 select for a list and «Да / нет», a
 * compact field for a number (with its unit) and a text; an empty value
 * reads «Не заполнено», muted. The label is for screen readers: the column
 * names the field.
 */
export function CellEditor({
  attribute,
  raw,
  label,
  disabled,
  error,
  onChange,
}: {
  attribute: AdminAttribute;
  raw: string;
  label: string;
  disabled?: boolean;
  error?: ReactNode;
  onChange: (raw: string) => void;
}) {
  switch (attribute.valueType) {
    case "enum":
    case "bool": {
      const options =
        attribute.valueType === "bool"
          ? [
              { value: "true", label: "Да" },
              { value: "false", label: "Нет" },
            ]
          : attribute.options
              .filter((option) => option.status === "active" || option.id === raw)
              .map((option) => ({ value: option.id, label: ruText(option.names) }));
      return (
        <Select<string>
          compact
          hideLabel
          className="cat-cell"
          label={label}
          value={raw}
          placeholder="Не заполнено"
          disabled={disabled}
          error={error}
          options={raw ? [{ value: EMPTY_CHOICE, label: "Не заполнено" }, ...options] : options}
          onChange={(next) => onChange(next === EMPTY_CHOICE ? "" : next)}
        />
      );
    }
    case "number": {
      const unit = ruText(attribute.unit);
      return (
        <TextField
          className="ac-field--compact cat-cell"
          label={label}
          value={raw}
          placeholder="Не заполнено"
          inputMode="decimal"
          disabled={disabled}
          error={error}
          onChange={onChange}
          trailing={unit ? <span className="cat-cell__unit">{unit}</span> : undefined}
        />
      );
    }
    case "text":
      return (
        <TextField
          className="ac-field--compact cat-cell"
          label={label}
          value={raw}
          placeholder="Не заполнено"
          disabled={disabled}
          error={error}
          maxLength={200}
          onChange={onChange}
        />
      );
  }
}
