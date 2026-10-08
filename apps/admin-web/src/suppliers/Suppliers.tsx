import type { AdminSupplierListItem, SupplierListQuery } from "@adclub/contracts";
import { Button, EmptyState, LoadingContent, SkeletonList } from "@adclub/ui";
import { apiClient } from "../api";
import { AppLink } from "../catalog/shared";
import { navigateTo, supplierNewPath, supplierPath } from "../router";
import { LoadError, MoreButton, usePaged } from "../vehicles/shared";
import {
  CitySelect,
  SearchBox,
  StateMark,
  SuppliersTabs,
  TypeSelect,
  useAddressFilters,
  useCities,
} from "./shared";
import { SUPPLIER_TYPE_TEXT } from "./supplier-words";

const STATES = [
  { value: "", label: "Все" },
  { value: "active", label: "Активен" },
  { value: "paused", label: "Пауза" },
  { value: "blocked", label: "Блокировка" },
  { value: "verified", label: "Проверенный" },
] as const;

type StateFilter = NonNullable<SupplierListQuery["state"]>;
type TypeFilter = NonNullable<SupplierListQuery["type"]>;

/**
 * A-SUP-02 «Поставщики» (SCREENS 7.4; TASK-036): by name, with the state,
 * the city, the type and the search (a part of the name or digits of the
 * БИН) in the address; every number is the server's. The rating and «проблема
 * с оплатой» come with stages C–D.
 */
export function Suppliers() {
  const { query, set } = useAddressFilters();
  const cities = useCities();
  const filters = {
    state: (query.get("state") || undefined) as StateFilter | undefined,
    cityId: query.get("cityId") || undefined,
    type: (query.get("type") || undefined) as TypeFilter | undefined,
    q: query.get("q")?.trim() || undefined,
  };
  const list = usePaged<AdminSupplierListItem>(async (cursor) => {
    const page = await apiClientList(filters, cursor);
    return { items: page.suppliers, total: page.total, nextCursor: page.nextCursor };
  }, JSON.stringify(filters));

  return (
    <>
      <div className="page__head">
        <h1 className="ac-text-title-l page__title">Поставщики</h1>
        <Button icon="plus" onClick={() => navigateTo(supplierNewPath())}>
          Новый поставщик
        </Button>
      </div>
      <SuppliersTabs active="suppliers" />
      <div className="filters">
        <SearchBox label="Название или цифры БИН" />
        <label className="select">
          <span className="ac-text-caption ac-muted">Состояние</span>
          <select
            value={filters.state ?? ""}
            onChange={(event) => set({ state: event.target.value || undefined })}
          >
            {STATES.map((state) => (
              <option key={state.value} value={state.value}>
                {state.label}
              </option>
            ))}
          </select>
        </label>
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
      </div>
      <LoadError error={list.first.error} retry={list.first.reload} />
      <LoadingContent
        ready={list.first.data !== undefined}
        indicator={list.first.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={6} label="Загрузка" />}
      >
        <p className="ac-text-body-s ac-muted">Всего: {list.total.toLocaleString("ru-RU")}</p>
        {list.items.length === 0 ? (
          <EmptyState
            icon="store"
            title="Поставщиков не найдено"
            text="Измените отборы или заведите поставщика из заявки на подключение."
          />
        ) : (
          <div className="table-wrap">
            <table className="admin-table suppliers-table">
              <thead>
                <tr>
                  <th scope="col">Название</th>
                  <th scope="col">Город</th>
                  <th scope="col">Что предлагает</th>
                  <th scope="col">Состояние</th>
                  <th scope="col" className="num">
                    Сотрудники
                  </th>
                  <th scope="col" className="num">
                    В продаже
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.items.map((supplier) => (
                  <tr key={supplier.id}>
                    <td>
                      <div className="cell-stack">
                        <span className="long-text" title={supplier.name}>
                          <AppLink href={supplierPath(supplier.id)}>{supplier.name}</AppLink>
                        </span>
                        {supplier.bin && (
                          <span className="ac-text-caption ac-muted mono">БИН {supplier.bin}</span>
                        )}
                      </div>
                    </td>
                    <td>{supplier.city.names.ru}</td>
                    <td>{SUPPLIER_TYPE_TEXT[supplier.type]}</td>
                    <td>
                      <StateMark state={supplier.state} verified={supplier.verified} />
                    </td>
                    <td className="num">{supplier.memberCount}</td>
                    <td className="num">{supplier.offersOnSale.toLocaleString("ru-RU")}</td>
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

function apiClientList(
  filters: Pick<SupplierListQuery, "state" | "cityId" | "type" | "q">,
  cursor?: string,
) {
  return apiClient.listSuppliers({ query: { ...filters, limit: 50, cursor } });
}
