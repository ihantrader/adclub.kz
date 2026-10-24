import type { AdminSupplierListItem, SupplierListQuery } from "@adclub/contracts";
import {
  Badge,
  Button,
  EmptyState,
  Icon,
  IconButton,
  LoadingContent,
  Rating,
  SkeletonList,
  TableToolbar,
} from "@adclub/ui";
import { apiClient } from "../api";
import { FilterSelect, StatusChips } from "../layout/filters";
import { Header, Muted, RowTitle, rowLink, Table } from "../layout/layout";
import { navigateTo, routePaths, supplierNewPath, supplierPath } from "../router";
import { LoadError, usePaged } from "../vehicles/shared";
import {
  CitySelect,
  MoreButton,
  SearchBox,
  StateMark,
  suppliersTabs,
  TypeSelect,
  useAddressFilters,
  useCities,
} from "./shared";
import { RATING_FILTER_TEXT, ratingLabel } from "./rating-words";
import { SUPPLIER_TYPE_TEXT } from "./supplier-words";
import "./suppliers.css";

type StateFilter = NonNullable<SupplierListQuery["state"]>;
type TypeFilter = NonNullable<SupplierListQuery["type"]>;
type RatingFilter = NonNullable<SupplierListQuery["rating"]>;

const STATES: { value: StateFilter; label: string }[] = [
  { value: "active", label: "Активен" },
  { value: "paused", label: "Пауза" },
  { value: "blocked", label: "Блокировка" },
  { value: "verified", label: "Проверенный" },
];

const COLUMNS = [
  { key: "name", header: "Поставщик" },
  { key: "city", header: "Город", width: 130 },
  { key: "type", header: "Что предлагает", width: 150 },
  { key: "state", header: "Состояние", width: 200 },
  { key: "rating", header: "Рейтинг", width: 120, numeric: true },
  { key: "members", header: "Сотрудники", width: 110, numeric: true },
  { key: "offers", header: "В продаже", width: 100, numeric: true },
];

/**
 * A-SUP-02 «Поставщики» (SCREENS 7.4; TASK-036, TASK-080): the section's
 * head with its two pages, one row of filters (the search by a part of the
 * name or digits of the БИН, the city, the type, the rating) and the state
 * as chips, all in the address; «Всего N» over the table; the whole row
 * opens the card. Only what departs from the usual is marked: a pause, a
 * blocking, «проверенный партнёр»; the rating — a star and «4,1 (9)», a new
 * supplier — a mark. Every number is the server's.
 */
export function Suppliers() {
  const { query, set } = useAddressFilters();
  const cities = useCities();
  const filters = {
    state: (query.get("state") || undefined) as StateFilter | undefined,
    cityId: query.get("cityId") || undefined,
    type: (query.get("type") || undefined) as TypeFilter | undefined,
    q: query.get("q")?.trim() || undefined,
    rating: (query.get("rating") || undefined) as RatingFilter | undefined,
  };
  const filtered = Object.values(filters).some(Boolean);
  const list = usePaged<AdminSupplierListItem>(async (cursor) => {
    const page = await apiClient.listSuppliers({ query: { ...filters, limit: 50, cursor } });
    return { items: page.suppliers, total: page.total, nextCursor: page.nextCursor };
  }, JSON.stringify(filters));
  const reset = () => navigateTo(routePaths.suppliers, { replace: true });

  return (
    <>
      <Header
        title="Поставщики"
        tabs={suppliersTabs("suppliers")}
        actions={
          <>
            <IconButton icon="refresh" label="Обновить" size={20} onClick={list.first.reload} />
            <Button size="s" icon="plus" onClick={() => navigateTo(supplierNewPath())}>
              Новый поставщик
            </Button>
          </>
        }
      />
      <div className="filters__group">
        <div className="filters">
          <SearchBox label="Поиск поставщиков" placeholder="Название или БИН" />
          <CitySelect
            value={filters.cityId ?? ""}
            onChange={(cityId) => set({ cityId: cityId || undefined })}
            cities={cities}
            any="Все"
          />
          <TypeSelect
            value={filters.type ?? ""}
            onChange={(type) => set({ type: type || undefined })}
            any="Все"
          />
          <FilterSelect<RatingFilter>
            label="Рейтинг"
            value={filters.rating}
            allLabel="Любой"
            options={(Object.keys(RATING_FILTER_TEXT) as RatingFilter[]).map((value) => ({
              value,
              label: RATING_FILTER_TEXT[value],
            }))}
            onChange={(rating) => set({ rating })}
          />
        </div>
        <StatusChips<StateFilter>
          label="Состояние"
          value={filters.state}
          chips={STATES}
          onChange={(state) => set({ state })}
        />
      </div>
      <LoadError error={list.first.error} retry={list.first.reload} />
      <LoadingContent
        ready={list.first.data !== undefined}
        indicator={list.first.indicator}
        label="Загрузка"
        swapKey={list.first.answerKey}
        skeleton={<SkeletonList rows={6} label="Загрузка" />}
      >
        <div className="list-block">
          <TableToolbar total={list.items.length === 0 ? null : list.total}>
            {filtered && (
              <Button variant="text" size="s" onClick={reset}>
                Сбросить фильтры
              </Button>
            )}
          </TableToolbar>
          {list.items.length === 0 ? (
            <EmptyState
              icon="store"
              title={filtered ? "Ничего не нашлось" : "Поставщиков пока нет"}
              text={
                filtered
                  ? "Измените поиск или отборы"
                  : "Заведите поставщика из заявки на подключение или вручную"
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
            <Table label="Поставщики" columns={COLUMNS}>
              {list.items.map((supplier) => (
                <SupplierRow key={supplier.id} supplier={supplier} />
              ))}
            </Table>
          )}
          <MoreButton list={list} />
        </div>
      </LoadingContent>
    </>
  );
}

function SupplierRow({ supplier }: { supplier: AdminSupplierListItem }) {
  const href = supplierPath(supplier.id);
  const rating = supplier.rating;
  return (
    <tr {...rowLink(href)}>
      <td>
        <RowTitle href={href} sub={supplier.bin ? `БИН ${supplier.bin}` : undefined}>
          <span className="clamp" title={supplier.name}>
            {supplier.name}
          </span>
        </RowTitle>
      </td>
      <td className="ac-text-body-s">
        <span className="cell-one-line" title={supplier.city.names.ru}>
          {supplier.city.names.ru}
        </span>
      </td>
      <td className="ac-text-body-s">{SUPPLIER_TYPE_TEXT[supplier.type]}</td>
      <td>
        {supplier.state === "active" && !supplier.verified ? (
          <Muted>—</Muted>
        ) : (
          <StateMark state={supplier.state} verified={supplier.verified} quiet />
        )}
      </td>
      <td className="num">
        {rating && rating.value !== null ? (
          <span className="supplier-rating">
            {rating.low && (
              <span className="supplier-rating__low" title="Ниже порога сигнала">
                <Icon name="alertTriangle" size={16} />
                <span className="ac-visually-hidden">Ниже порога сигнала</span>
              </span>
            )}
            <Rating
              value={rating.value}
              count={rating.count}
              emptyText=""
              label={ratingLabel(rating.value, rating.count)}
              locale="ru-RU"
            />
          </span>
        ) : (
          <Badge tone="neutral" icon="star">
            Новый
          </Badge>
        )}
      </td>
      <td className="num">{supplier.memberCount.toLocaleString("ru-RU")}</td>
      <td className="num">
        {supplier.offersOnSale > 0 ? (
          supplier.offersOnSale.toLocaleString("ru-RU")
        ) : (
          <Muted>—</Muted>
        )}
      </td>
    </tr>
  );
}
