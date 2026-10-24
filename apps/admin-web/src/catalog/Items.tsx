import type {
  AdminCategoryTreeResponse,
  AdminCatalogItemListEntry,
  AdminCatalogItemPage,
} from "@adclub/contracts";
import {
  Badge,
  Banner,
  Button,
  EmptyState,
  IconButton,
  LoadingContent,
  SkeletonList,
  StatusBadge,
  TableToolbar,
} from "@adclub/ui";
import { useEffect, useState } from "react";
import { apiClient } from "../api";
import { loadErrorText } from "../errors";
import { FilterSearch, FilterSelect, FlagChips } from "../layout/filters";
import { Header, RowTitle, rowLink, Table, Thumb } from "../layout/layout";
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
import { catalogTabs } from "./shared";
import { ruText } from "./values";

const PAGE = 50;

/** Brands of every status: an archived brand's items are found too. */
const brandSearch = createChoiceSources(apiClient).brands();

/** The flags of A-CAT-04 as chips, each the rule of a home card where there is one. */
const FLAGS: { key: ItemFilterKey; value: string; label: string }[] = [
  { key: "hasOffers", value: "true", label: "Есть предложения" },
  { key: "withoutPhoto", value: "true", label: "Без фото" },
  { key: "completeness", value: "incomplete", label: "Неполные характеристики" },
  { key: "withoutCompatibility", value: "true", label: "Без совместимости" },
  { key: "withoutTranslation", value: "true", label: "Без перевода" },
  { key: "sameProduct", value: "matching", label: "Совпадают с другим товаром" },
];

const COLUMNS = [
  { key: "photo", header: "Фото", width: 64, hiddenHeader: true },
  { key: "item", header: "Позиция" },
  { key: "category", header: "Категория", width: 260 },
  { key: "state", header: "Состояние", width: 200 },
  { key: "offers", header: "Предложений", width: 130, numeric: true },
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
 * A-CAT-04 «Позиции» (SCREENS 7.2; TASK-035, TASK-080): search by the
 * article in any spelling and the name in any language; one row of selects
 * and one row of flag chips, in the address under the server's own names —
 * a card of the home screen opens this list with the very filters it
 * counted; «Всего N» over the table; pages by the server's cursor. Only
 * what departs from the usual is marked: a draft, the archive, the
 * incomplete — an active, complete item has no mark.
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

  const reset = () => {
    setSearch("");
    navigateTo(routePaths.catalogItems, { replace: true });
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

  const total = first.data?.total ?? 0;
  return (
    <>
      <Header
        title="Справочник"
        tabs={catalogTabs("items")}
        actions={
          <>
            <IconButton icon="refresh" label="Обновить" size={20} onClick={first.reload} />
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
          </>
        }
      />

      <div className="filters__group">
        <div className="filters">
          <FilterSearch
            label="Поиск позиций"
            placeholder="Артикул или название"
            value={search}
            onChange={setSearch}
          />
          <FilterSelect
            label="Категория"
            value={filters.categoryId}
            options={[...categories].map(([id, name]) => ({ value: id, label: name }))}
            onChange={(categoryId) => set({ categoryId })}
          />
          <SearchSelect
            compact
            label="Бренд"
            value={brand}
            empty="Все"
            search={brandSearch}
            onChange={(choice) => {
              setBrandLabel(choice);
              set({ brandId: choice?.id });
            }}
          />
          <FilterSelect
            label="Тип"
            value={filters.type}
            options={Object.entries(ITEM_TYPE_TEXT).map(([value, label]) => ({ value, label }))}
            onChange={(type) => set({ type })}
          />
          <FilterSelect
            label="Статус"
            value={filters.status}
            options={Object.entries(ITEM_STATUS_TEXT).map(([value, label]) => ({ value, label }))}
            onChange={(status) => set({ status })}
          />
        </div>
        <FlagChips
          label="Отборы позиций"
          flags={FLAGS}
          isOn={(flag) => filters[flag] === FLAGS.find((entry) => entry.key === flag)?.value}
          onToggle={(flag, on) =>
            set({ [flag]: on ? FLAGS.find((entry) => entry.key === flag)?.value : undefined })
          }
        />
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
        <div className="list-block">
          <TableToolbar total={items.length === 0 ? null : total}>
            {filtered(filters) && (
              <Button variant="text" size="s" onClick={reset}>
                Сбросить фильтры
              </Button>
            )}
          </TableToolbar>
          {items.length === 0 ? (
            <EmptyState
              icon="package"
              title={filtered(filters) ? "Ничего не нашлось" : "Позиций пока нет"}
              text={filtered(filters) ? "Измените поиск или отборы" : "Создайте первую позицию"}
              action={
                filtered(filters) ? (
                  <Button variant="secondary" onClick={reset}>
                    Сбросить фильтры
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <Table label="Позиции справочника" columns={COLUMNS}>
              {items.map((item) => {
                const name = ruText(item.names) || "Без названия";
                const link = rowLink(catalogItemPath(item.id));
                return (
                  <tr
                    key={item.id}
                    {...link}
                    className={
                      item.status === "archived" ? `${link.className} row--muted` : link.className
                    }
                  >
                    <td>
                      <Thumb src={item.photo?.thumbUrl} />
                    </td>
                    <td>
                      <RowTitle
                        href={catalogItemPath(item.id)}
                        sub={
                          item.type === "service"
                            ? "Услуга"
                            : [item.brand?.name, item.article].filter(Boolean).join(" · ") || "—"
                        }
                      >
                        <span className="clamp" title={name}>
                          {name}
                        </span>
                      </RowTitle>
                    </td>
                    <td className="ac-text-body-s">
                      <span className="clamp" title={categories.get(item.categoryId)}>
                        {categories.get(item.categoryId) ?? "—"}
                      </span>
                    </td>
                    <td>
                      <span className="badges">
                        {item.status !== "active" && (
                          <StatusBadge kind="catalogItem" status={item.status}>
                            {ITEM_STATUS_TEXT[item.status]}
                          </StatusBadge>
                        )}
                        {item.completeness === "incomplete" && (
                          <Badge tone="warning" icon="alertTriangle">
                            Неполная
                          </Badge>
                        )}
                      </span>
                    </td>
                    <td className="num">
                      {item.offersOnSale > 0 ? item.offersOnSale.toLocaleString("ru-RU") : "—"}
                    </td>
                  </tr>
                );
              })}
            </Table>
          )}
          {moreError && <Banner tone="danger">{moreError}</Banner>}
          {next && (
            <Button variant="secondary" size="s" onClick={loadMore} loading={loadingMore}>
              Показать ещё
            </Button>
          )}
        </div>
      </LoadingContent>
    </>
  );
}
