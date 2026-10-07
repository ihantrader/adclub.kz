import { isApiError } from "@adclub/api-client";
import {
  catalogValuesRejectedDetailsSchema,
  type AdminAttribute,
  type AttributeValue,
  type CategoryFillPage,
  type CategoryFillRow,
} from "@adclub/contracts";
import {
  Banner,
  Button,
  Checkbox,
  EmptyState,
  LoadingContent,
  SkeletonList,
  useToast,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useState } from "react";
import { apiClient } from "../api";
import { loadErrorText } from "../errors";
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
import { AppLink, CatalogTabs } from "./shared";
import { numberHint, parseValue, ruText, valueInput, valueText } from "./values";

const PAGE = 50;

interface Draft {
  raw: string;
  /** The value the edit is made against: as read, or as stored after a conflict. */
  previous: AttributeValue;
}

/**
 * A-CAT-03 «Дозаполнение» (SCREENS 7.2; TASK-035): the items of a
 * subcategory × its active characteristics, a page at a time (thousands of
 * items never load at once), «Только пустые» by the chosen characteristic,
 * an editor in the cell by type. Saving is one request, all or nothing:
 * refused cells show why, a colleague's change shows the value stored now,
 * and every typed value stays.
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
  const { edits: currentEdits } = pending();

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
    }
  };

  const category = page?.category;
  return (
    <>
      <div className="page__head page__head--back">
        <h1 className="ac-text-title-l page__title">
          Дозаполнение{category ? ` · ${ruText(category.names)}` : ""}
        </h1>
      </div>
      <CatalogTabs active={null} />
      <div className="filters">
        <AppLink href={withQuery(routePaths.catalog, { node: categoryId })}>
          ← К характеристикам
        </AppLink>
        <label className="select">
          <span className="ac-text-caption ac-muted">Характеристика</span>
          <select
            value={attributeId ?? ""}
            onChange={(event) => setFilter({ attribute: event.target.value || null })}
          >
            <option value="">Все</option>
            {attributes.map((attribute) => (
              <option key={attribute.id} value={attribute.id}>
                {ruText(attribute.names)}
              </option>
            ))}
          </select>
        </label>
        <Checkbox
          label="Только пустые"
          description={attributeId ? undefined : "Выберите характеристику"}
          checked={onlyEmpty}
          disabled={!attributeId}
          onChange={(empty) => setFilter({ empty })}
        />
        <span className="ac-text-body-s ac-muted">
          {page ? `Позиций: ${page.total.toLocaleString("ru-RU")}` : ""}
        </span>
      </div>
      {banner && <Banner tone="warning">{banner}</Banner>}
      {first.error !== undefined && <Banner tone="danger">{loadErrorText(first.error)}</Banner>}
      <LoadingContent
        ready={page !== undefined}
        indicator={first.indicator}
        label="Загрузка"
        swapKey={first.answerKey}
        skeleton={<SkeletonList rows={6} label="Загрузка" />}
      >
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
          />
        ) : (
          <div className="table-wrap">
            <table className="admin-table fill-table">
              <thead>
                <tr>
                  <th scope="col" className="fill-table__item">
                    Позиция
                  </th>
                  {attributes.map((attribute) => (
                    <th
                      key={attribute.id}
                      scope="col"
                      className={attribute.id === attributeId ? "fill-table__col--on" : undefined}
                      title={numberHint(attribute) ?? undefined}
                    >
                      {ruText(attribute.names)}
                      {attribute.isRequiredForComplete ? " *" : ""}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.item.id}>
                    <td className="fill-table__item">
                      <div className="cell-stack">
                        <AppLink href={catalogItemPath(row.item.id)}>
                          <span className="clamp" title={ruText(row.item.names)}>
                            {ruText(row.item.names)}
                          </span>
                        </AppLink>
                        <span className="ac-text-caption ac-muted">
                          {[row.item.brand?.name, row.item.article].filter(Boolean).join(" · ")}
                        </span>
                      </div>
                    </td>
                    {attributes.map((attribute) => {
                      const cell = cellKey(row.item.id, attribute.id);
                      const draft = drafts.get(cell);
                      const error = errors.get(cell);
                      const stored = rowValue(row, attribute.id);
                      return (
                        <td
                          key={attribute.id}
                          className={[
                            "fill-cell",
                            currentEdits.has(cell) ? "fill-cell--changed" : "",
                            error ? "fill-cell--error" : "",
                          ].join(" ")}
                        >
                          <CellEditor
                            attribute={attribute}
                            raw={draft ? draft.raw : valueInput(stored)}
                            label={`${ruText(attribute.names)}: ${ruText(row.item.names)}`}
                            disabled={!online}
                            invalid={error !== undefined}
                            onChange={(raw) => edit(row, attribute, raw)}
                          />
                          {error && (
                            <span className="fill-cell__error ac-text-caption" role="alert">
                              {error.message}
                              {error.current !== undefined &&
                                `. Сейчас: ${valueText(attribute, error.current)}`}
                            </span>
                          )}
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
          <Button variant="secondary" onClick={loadMore} loading={loadingMore}>
            Показать ещё
          </Button>
        )}
      </LoadingContent>

      {drafts.size > 0 && (
        <div className="save-bar" role="region" aria-label="Несохранённые правки">
          <span className="ac-text-body-s">Изменено ячеек: {currentEdits.size}</span>
          <div className="button-row">
            <Button
              variant="secondary"
              size="s"
              onClick={() => {
                setDrafts(new Map());
                setErrors(new Map());
              }}
            >
              Отменить правки
            </Button>
            <Button size="s" disabled={!online || currentEdits.size === 0} onClick={save}>
              Сохранить
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

/** An editor of one value by its type (shared with the item's characteristics). */
export function CellEditor({
  attribute,
  raw,
  label,
  disabled,
  invalid,
  onChange,
}: {
  attribute: AdminAttribute;
  raw: string;
  label: string;
  disabled?: boolean;
  invalid?: boolean;
  onChange: (raw: string) => void;
}) {
  switch (attribute.valueType) {
    case "enum":
      return (
        <select
          className="cell-input"
          aria-label={label}
          aria-invalid={invalid || undefined}
          value={raw}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">—</option>
          {attribute.options
            .filter((option) => option.status === "active" || option.id === raw)
            .map((option) => (
              <option key={option.id} value={option.id}>
                {ruText(option.names)}
              </option>
            ))}
        </select>
      );
    case "bool":
      return (
        <select
          className="cell-input"
          aria-label={label}
          aria-invalid={invalid || undefined}
          value={raw}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">—</option>
          <option value="true">Да</option>
          <option value="false">Нет</option>
        </select>
      );
    case "number": {
      const unit = ruText(attribute.unit);
      return (
        <span className="cell-number">
          <input
            className="cell-input"
            inputMode="decimal"
            aria-label={label}
            aria-invalid={invalid || undefined}
            value={raw}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
          />
          {unit && <span className="ac-text-caption ac-muted">{unit}</span>}
        </span>
      );
    }
    case "text":
      return (
        <input
          className="cell-input"
          aria-label={label}
          aria-invalid={invalid || undefined}
          value={raw}
          disabled={disabled}
          maxLength={200}
          onChange={(event) => onChange(event.target.value)}
        />
      );
  }
}
