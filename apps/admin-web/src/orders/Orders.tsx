import type { AdminOrderSummary } from "@adclub/contracts";
import { Checkbox, EmptyState, LoadingContent, SkeletonList } from "@adclub/ui";
import { useEffect, useState } from "react";
import { apiClient } from "../api";
import { AppLink } from "../catalog/shared";
import { formatMoment } from "../format";
import { orderPath, supplierPath, userPath } from "../router";
import { SearchSelect } from "../search-select/SearchSelect";
import type { Choice } from "../search-select/search-select-core";
import { createChoiceSources } from "../search-select/sources";
import { CitySelect, SearchBox, useAddressFilters, useCities } from "../suppliers/shared";
import { LoadError, MoreButton, usePaged } from "../vehicles/shared";
import {
  moneyText,
  ORDER_STATUS_TEXT,
  ORDER_STATUSES,
  orderFiltersOf,
  statusTone,
} from "./order-words";

const supplierSearch = createChoiceSources(apiClient).suppliers();

/**
 * A-ORD-01 «Заявки» (SCREENS 7.5; TASK-036.B): the search by the number
 * («1028», «№ 1028») and by the customer's phone (the server matches the
 * full number; the list shows it partly hidden), the filters — status,
 * supplier, city, period, «Закрыта поздно», «Закрыта администратором»,
 * «Показывать тестовые» — in the address, «Всего N», «Показать ещё». Never
 * the code or the QR. «Есть жалоба» is stage C.
 */
export function Orders() {
  const { query, set } = useAddressFilters();
  const cities = useCities();
  const filters = orderFiltersOf(query);
  const list = usePaged<AdminOrderSummary>(async (cursor) => {
    const page = await apiClient.listAdminOrders({ query: { ...filters, limit: 50, cursor } });
    return { items: page.orders, total: page.total, nextCursor: page.nextCursor };
  }, JSON.stringify(filters));
  const supplier = useSupplierChoice(filters.supplierId ?? null, list.items);

  return (
    <>
      <div className="page__head">
        <h1 className="ac-text-title-l page__title">Заявки</h1>
      </div>
      <div className="filters filters--grid">
        <SearchBox label="Номер заявки или телефон клиента" />
        <label className="select">
          <span className="ac-text-caption ac-muted">Статус</span>
          <select
            value={filters.status ?? ""}
            onChange={(event) => set({ status: event.target.value || undefined })}
          >
            <option value="">Все</option>
            {ORDER_STATUSES.map((status) => (
              <option key={status} value={status}>
                {ORDER_STATUS_TEXT[status]}
              </option>
            ))}
          </select>
        </label>
        <div className="filters__select-search">
          <SearchSelect
            label="Поставщик"
            value={supplier.value}
            onChange={(choice) => {
              supplier.remember(choice);
              set({ supplierId: choice?.id });
            }}
            search={supplierSearch}
            empty="Все"
          />
        </div>
        <CitySelect
          value={filters.cityId ?? ""}
          onChange={(cityId) => set({ cityId: cityId || undefined })}
          cities={cities}
          any="Все"
        />
        <label className="select">
          <span className="ac-text-caption ac-muted">С (время Алматы)</span>
          <input
            type="date"
            value={query.get("from") ?? ""}
            onChange={(event) => set({ from: event.target.value || undefined })}
          />
        </label>
        <label className="select">
          <span className="ac-text-caption ac-muted">По</span>
          <input
            type="date"
            value={query.get("to") ?? ""}
            onChange={(event) => set({ to: event.target.value || undefined })}
          />
        </label>
      </div>
      <div className="filters">
        <Checkbox
          label="Закрыта поздно"
          checked={filters.closedLate === "true"}
          onChange={(on) => set({ closedLate: on ? "true" : undefined })}
        />
        <Checkbox
          label="Закрыта администратором"
          checked={filters.closedByAdmin === "true"}
          onChange={(on) => set({ closedByAdmin: on ? "true" : undefined })}
        />
        <Checkbox
          label="Показывать тестовые"
          checked={filters.test === "include"}
          onChange={(on) => set({ test: on ? "include" : undefined })}
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
          <EmptyState icon="receipt" title="Заявок не найдено" text="Измените поиск или отборы" />
        ) : (
          <OrdersTable orders={list.items} />
        )}
        <MoreButton list={list} />
      </LoadingContent>
    </>
  );
}

/**
 * The rows of orders — the list, the supplier's and the user's tabs: the
 * number (to the card), the item, the customer, the supplier, the status
 * with how it was closed, the sum, when. `hide` leaves out a column the
 * page already says (the supplier on its card, the customer on theirs).
 */
export function OrdersTable({
  orders,
  hide = [],
}: {
  orders: readonly AdminOrderSummary[];
  hide?: readonly ("customer" | "supplier")[];
}) {
  return (
    <div className="table-wrap">
      <table className="admin-table orders-table">
        <thead>
          <tr>
            <th scope="col">Номер</th>
            <th scope="col">Позиция</th>
            {!hide.includes("customer") && <th scope="col">Клиент</th>}
            {!hide.includes("supplier") && <th scope="col">Поставщик</th>}
            <th scope="col">Статус</th>
            <th scope="col" className="num">
              Сумма
            </th>
            <th scope="col">Оформлена</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((order) => (
            <tr key={order.id}>
              <td className="num nowrap">
                <AppLink href={orderPath(order.id)}>№ {order.number}</AppLink>
                {order.isTest && <span className="ac-text-caption ac-muted"> · тестовая</span>}
              </td>
              <td>
                <div className="cell-stack">
                  <span className="long-text" title={order.item.name.text}>
                    {order.item.name.text}
                  </span>
                  <span className="ac-text-caption ac-muted">
                    {[order.item.brand, order.item.article].filter(Boolean).join(" · ")} ·{" "}
                    {order.quantity} шт.
                  </span>
                </div>
              </td>
              {!hide.includes("customer") && (
                <td>
                  <div className="cell-stack">
                    <AppLink href={userPath(order.customer.accountId)}>
                      {order.customer.name ?? "Без имени"}
                    </AppLink>
                    <span className="ac-text-caption ac-muted num">{order.customer.phone}</span>
                  </div>
                </td>
              )}
              {!hide.includes("supplier") && (
                <td>
                  <span className="long-text" title={order.supplier.name}>
                    <AppLink href={supplierPath(order.supplier.id)}>{order.supplier.name}</AppLink>
                  </span>
                </td>
              )}
              <td>
                <div className="cell-stack">
                  <span className={`status ${statusTone(order.status)}`}>
                    {ORDER_STATUS_TEXT[order.status]}
                  </span>
                  {order.closure?.method === "admin" && (
                    <span className="ac-text-caption ac-muted">закрыта администратором</span>
                  )}
                  {order.closure?.late && (
                    <span className="ac-text-caption ac-muted">закрыта поздно</span>
                  )}
                </div>
              </td>
              <td className="num">{moneyText(order.total)}</td>
              <td className="ac-text-body-s num">{formatMoment(order.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The chosen supplier of the filter: its name from what was chosen here,
 * else from the rows, else from its card (an address opened from a link).
 */
function useSupplierChoice(supplierId: string | null, rows: readonly AdminOrderSummary[]) {
  const [chosen, setChosen] = useState<Choice | null>(null);
  const [loaded, setLoaded] = useState<Choice | null>(null);
  const fromRows = rows.find((row) => row.supplier.id === supplierId)?.supplier;
  const known =
    chosen?.id === supplierId
      ? chosen
      : fromRows
        ? { id: fromRows.id, label: fromRows.name }
        : loaded?.id === supplierId
          ? loaded
          : null;
  const isKnown = known !== null;
  useEffect(() => {
    if (!supplierId || isKnown) return;
    let cancelled = false;
    apiClient.getAdminSupplier({ supplierId }).then(
      (answer) => {
        if (!cancelled) setLoaded({ id: supplierId, label: answer.supplier.name });
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [supplierId, isKnown]);
  return {
    value: supplierId ? (known ?? { id: supplierId, label: "Выбранный поставщик" }) : null,
    remember: setChosen,
  };
}
