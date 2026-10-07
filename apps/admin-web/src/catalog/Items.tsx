import type {
  AdminCategoryTreeResponse,
  AdminCatalogItemListEntry,
  AdminCatalogItemPage,
} from "@adclub/contracts";
import {
  Banner,
  Button,
  Checkbox,
  EmptyState,
  LoadingContent,
  SearchField,
  SkeletonList,
} from "@adclub/ui";
import { useEffect, useState } from "react";
import { apiClient } from "../api";
import { loadErrorText } from "../errors";
import { catalogItemPath, navigateTo, routePaths, useLocation } from "../router";
import { SearchSelect } from "../search-select/SearchSelect";
import type { Choice } from "../search-select/search-select-core";
import { createChoiceSources } from "../search-select/sources";
import { useLoad } from "../use-load";
import { ITEM_STATUS_TEXT, ITEM_TYPE_TEXT } from "./catalog-words";
import {
  filtered,
  itemFiltersOf,
  itemsLink,
  listQueryOf,
  type ItemFilterKey,
  type ItemFilters,
} from "./item-filters";
import { AppLink, CatalogTabs } from "./shared";
import { ruText } from "./values";

const PAGE = 50;

/** Brands of every status: an archived brand's items are found too. */
const brandSearch = createChoiceSources(apiClient).brands();

/** The checkbox filters of A-CAT-04, each the rule of a home card where there is one. */
const FLAGS: { key: ItemFilterKey; value: string; label: string }[] = [
  { key: "hasOffers", value: "true", label: "Есть предложения" },
  { key: "withoutPhoto", value: "true", label: "Без фото" },
  { key: "completeness", value: "incomplete", label: "Неполные характеристики" },
  { key: "withoutCompatibility", value: "true", label: "Без совместимости" },
  { key: "withoutTranslation", value: "true", label: "Без перевода" },
  { key: "sameProduct", value: "matching", label: "Совпадают с другим товаром" },
];

/** Subcategories of the tree as «Узел · Подкатегория», for the filter and the rows. */
export function subcategoryNames(tree: AdminCategoryTreeResponse | undefined): Map<string, string> {
  const names = new Map<string, string>();
  for (const node of tree?.categories ?? []) {
    for (const child of node.children) {
      names.set(child.id, `${ruText(node.names)} · ${ruText(child.names)}`);
    }
  }
  return names;
}

/**
 * A-CAT-04 «Позиции» (SCREENS 7.2; TASK-035): search by the article in any
 * spelling and the name in any language, filters in the address under the
 * server's own names — a card of the home screen opens this list with the
 * very filters it counted — pages by the server's cursor and «всего N».
 */
export function Items() {
  const location = useLocation();
  const filters = itemFiltersOf(location.query);
  const key = JSON.stringify(filters);
  const request = (cursor?: string) =>
    apiClient.listAdminCatalogItems({ query: listQueryOf(filters, { limit: PAGE, cursor }) });
  const first = useLoad<AdminCatalogItemPage>(() => request(), key);
  const tree = useLoad<AdminCategoryTreeResponse>(() => apiClient.listAdminCategories(), "tree");
  // The chosen brand's name: from this page's rows, else what was chosen here.
  const [brandLabel, setBrandLabel] = useState<Choice | null>(null);
  const brandOfRows = first.data?.items.find((item) => item.brand?.id === filters.brandId)?.brand;
  const brand: Choice | null = !filters.brandId
    ? null
    : brandLabel?.id === filters.brandId
      ? brandLabel
      : { id: filters.brandId, label: brandOfRows?.name ?? "Выбранный бренд" };
  const [more, setMore] = useState<{
    key: string;
    items: AdminCatalogItemListEntry[];
    next: string | null;
  }>({ key: "", items: [], next: null });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [search, setSearch] = useState(filters.q ?? "");
  const extra = more.key === key ? more : { key, items: [], next: null };
  const items = [...(first.data?.items ?? []), ...extra.items];
  const next = extra.items.length > 0 ? extra.next : (first.data?.nextCursor ?? null);
  const categories = subcategoryNames(tree.data);

  const set = (patch: ItemFilters) => {
    const values: ItemFilters = { ...filters, ...patch };
    for (const name of Object.keys(values) as ItemFilterKey[]) {
      if (!values[name]) delete values[name];
    }
    navigateTo(itemsLink(values), { replace: true });
  };

  // The search goes to the address a moment after typing stops.
  useEffect(() => {
    const trimmed = search.trim();
    if (trimmed === (filters.q ?? "")) return;
    const timer = setTimeout(() => set({ q: trimmed || undefined }), 350);
    return () => clearTimeout(timer);
  });

  const loadMore = async () => {
    if (!next) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await request(next);
      setMore({ key, items: [...extra.items, ...page.items], next: page.nextCursor });
    } catch (thrown) {
      setMoreError(loadErrorText(thrown));
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <>
      <div className="page__head">
        <h1 className="ac-text-title-l page__title">Справочник</h1>
        <div className="page__tools">
          <Button variant="secondary" size="s" icon="refresh" onClick={first.reload}>
            Обновить
          </Button>
          <Button
            size="s"
            icon="plus"
            onClick={() =>
              navigateTo(
                filters.categoryId
                  ? `${routePaths.catalogItemNew}?categoryId=${filters.categoryId}`
                  : routePaths.catalogItemNew,
              )
            }
          >
            Новая позиция
          </Button>
        </div>
      </div>
      <CatalogTabs active="items" />

      <div className="filters">
        <SearchField
          label="Артикул или название"
          value={search}
          onChange={setSearch}
          clearLabel="Очистить"
        />
        <label className="select">
          <span className="ac-text-caption ac-muted">Категория</span>
          <select
            value={filters.categoryId ?? ""}
            onChange={(event) => set({ categoryId: event.target.value || undefined })}
          >
            <option value="">Все</option>
            {[...categories].map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <SearchSelect
          label="Бренд"
          value={brand}
          empty="Все"
          search={brandSearch}
          onChange={(choice) => {
            setBrandLabel(choice);
            set({ brandId: choice?.id });
          }}
        />
        <label className="select">
          <span className="ac-text-caption ac-muted">Тип</span>
          <select
            value={filters.type ?? ""}
            onChange={(event) => set({ type: event.target.value || undefined })}
          >
            <option value="">Все</option>
            {Object.entries(ITEM_TYPE_TEXT).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="select">
          <span className="ac-text-caption ac-muted">Статус</span>
          <select
            value={filters.status ?? ""}
            onChange={(event) => set({ status: event.target.value || undefined })}
          >
            <option value="">Все</option>
            {Object.entries(ITEM_STATUS_TEXT).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="filters filters--flags">
        {FLAGS.map((flag) => (
          <Checkbox
            key={flag.key}
            label={flag.label}
            checked={filters[flag.key] === flag.value}
            onChange={(checked) => set({ [flag.key]: checked ? flag.value : undefined })}
          />
        ))}
        {filtered(filters) && (
          <Button
            variant="text"
            size="s"
            onClick={() => {
              setSearch("");
              navigateTo(routePaths.catalogItems, { replace: true });
            }}
          >
            Сбросить
          </Button>
        )}
      </div>

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
        ready={first.data !== undefined}
        indicator={first.indicator}
        label="Загрузка"
        swapKey={first.answerKey}
        skeleton={<SkeletonList rows={6} label="Загрузка" />}
      >
        <p className="ac-text-body-s ac-muted" aria-live="polite">
          Всего: {(first.data?.total ?? 0).toLocaleString("ru-RU")}
        </p>
        {items.length === 0 ? (
          <EmptyState
            icon="package"
            title={filtered(filters) ? "Ничего не нашлось" : "Позиций пока нет"}
            text={filtered(filters) ? "Измените поиск или отборы" : "Создайте первую позицию"}
          />
        ) : (
          <div className="table-wrap">
            <table className="admin-table items-table">
              <thead>
                <tr>
                  <th scope="col" aria-label="Фото" />
                  <th scope="col">Позиция</th>
                  <th scope="col">Категория</th>
                  <th scope="col">Полнота</th>
                  <th scope="col">Статус</th>
                  <th scope="col" className="num">
                    Предложений
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr
                    key={item.id}
                    className={item.status === "archived" ? "row--muted" : undefined}
                  >
                    <td className="thumb-cell">
                      {item.photo ? (
                        <img className="thumb" src={item.photo.thumbUrl} alt="" loading="lazy" />
                      ) : (
                        <span className="thumb thumb--empty" aria-label="Без фото" />
                      )}
                    </td>
                    <td>
                      <div className="cell-stack">
                        <AppLink href={catalogItemPath(item.id)}>
                          <span className="clamp" title={ruText(item.names)}>
                            {ruText(item.names) || "Без названия"}
                          </span>
                        </AppLink>
                        <span className="ac-text-caption ac-muted">
                          {item.type === "service"
                            ? "Услуга"
                            : [item.brand?.name, item.article].filter(Boolean).join(" · ") || "—"}
                        </span>
                      </div>
                    </td>
                    <td className="ac-text-body-s">
                      <span className="clamp" title={categories.get(item.categoryId)}>
                        {categories.get(item.categoryId) ?? "—"}
                      </span>
                    </td>
                    <td className="ac-text-body-s">
                      {item.completeness === "complete" ? (
                        "Полная"
                      ) : (
                        <span className="warning-text">Неполная</span>
                      )}
                    </td>
                    <td>
                      <span
                        className={`status status--${item.status === "active" ? "open" : item.status === "draft" ? "acknowledged" : "closed"}`}
                      >
                        {ITEM_STATUS_TEXT[item.status]}
                      </span>
                    </td>
                    <td className="num">{item.offersOnSale}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {moreError && <Banner tone="danger">{moreError}</Banner>}
        {next && (
          <Button variant="secondary" onClick={loadMore} loading={loadingMore}>
            Показать ещё
          </Button>
        )}
      </LoadingContent>
      <p className="ac-text-caption ac-muted">
        Нужен бренд, которого нет в списке, — добавьте его в карточке позиции («Новый бренд»).{" "}
        <AppLink href={routePaths.catalog}>Категории и характеристики</AppLink>
      </p>
    </>
  );
}
