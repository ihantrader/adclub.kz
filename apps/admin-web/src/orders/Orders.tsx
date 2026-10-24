import type { AdminOrderSummary } from "@adclub/contracts";
import {
  Banner,
  Button,
  DateField,
  EmptyState,
  IconButton,
  LoadingContent,
  SkeletonList,
  StatusBadge,
  TableToolbar,
  TypeMark,
  type Choice,
} from "@adclub/ui";
import { useEffect, useState } from "react";
import { apiClient } from "../api";
import { formatMoment } from "../format";
import { FilterSearch, FilterSelect, FlagChips } from "../layout/filters";
import { Header, RowTitle, rowLink, Table, type Column } from "../layout/layout";
import { navigateTo, orderPath, routePaths } from "../router";
import { SearchSelect } from "../search-select/SearchSelect";
import { createChoiceSources } from "../search-select/sources";
import { useAddressFilters, useCities } from "../suppliers/shared";
import { LoadError, usePaged, type Paged } from "../vehicles/shared";
import {
  moneyText,
  ORDER_KIND_TEXT,
  ORDER_KINDS,
  ORDER_STATUS_TEXT,
  ORDER_STATUSES,
  orderFiltersOf,
  orderKindMark,
  ordersFiltered,
  orderStatusText,
} from "./order-words";
import "./orders.css";

const supplierSearch = createChoiceSources(apiClient).suppliers();

/** The flags of A-ORD-01 as chips in one row (X5), each with its value in the address. */
const FLAGS = [
  { key: "closedLate", value: "true", label: "Закрыта поздно" },
  { key: "closedByAdmin", value: "true", label: "Закрыта администратором" },
  { key: "hasComplaint", value: "true", label: "Есть жалоба" },
  { key: "test", value: "include", label: "Показывать тестовые" },
] as const;

type FlagKey = (typeof FLAGS)[number]["key"];

/**
 * A-ORD-01 «Заявки» (SCREENS 7.5; TASK-036.B, TASK-080): the search by the
 * number («1028», «№ 1028») and by the customer's phone (the server matches
 * the full number; the list shows it partly hidden); one row of filters —
 * status, kind (TASK-039), supplier, city, the period — and one row of flag
 * chips — «Закрыта поздно», «Закрыта администратором», «Есть жалоба»
 * (TASK-049), «Показывать тестовые»; all in the address. «Всего N» over the
 * table, the row opens the order, «Показать ещё» by the server's cursor.
 * Never the code or the QR.
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
  const [search, setSearch] = useState(query.get("q") ?? "");
  const from = query.get("from") ?? "";
  const to = query.get("to") ?? "";
  const filtered = ordersFiltered(filters);

  // The search goes to the address a moment after typing stops.
  useEffect(() => {
    const trimmed = search.trim();
    if (trimmed === (query.get("q") ?? "")) return;
    const timer = setTimeout(() => set({ q: trimmed || undefined }), 350);
    return () => clearTimeout(timer);
  });

  const reset = () => {
    setSearch("");
    navigateTo(routePaths.orders, { replace: true });
  };

  return (
    <>
      <Header
        title="Заявки"
        actions={
          <IconButton icon="refresh" label="Обновить" size={20} onClick={list.first.reload} />
        }
      />
      <div className="filters__group">
        <div className="filters orders-filters">
          <FilterSearch
            label="Поиск заявок"
            placeholder="№ заявки или телефон клиента"
            value={search}
            onChange={setSearch}
            onSubmit={() => set({ q: search.trim() || undefined })}
          />
          <FilterSelect
            label="Статус"
            value={filters.status}
            options={ORDER_STATUSES.map((status) => ({
              value: status,
              label: ORDER_STATUS_TEXT[status],
            }))}
            onChange={(status) => set({ status })}
          />
          <FilterSelect
            label="Тип"
            value={filters.kind}
            options={ORDER_KINDS.map((kind) => ({ value: kind, label: ORDER_KIND_TEXT[kind] }))}
            onChange={(kind) => set({ kind })}
          />
          <SearchSelect
            compact
            label="Поставщик"
            value={supplier.value}
            onChange={(choice) => {
              supplier.remember(choice);
              set({ supplierId: choice?.id });
            }}
            search={supplierSearch}
            empty="Все"
          />
          <FilterSelect
            label="Город"
            value={filters.cityId}
            options={cities
              .filter((city) => city.status === "active" || city.id === filters.cityId)
              .map((city) => ({ value: city.id, label: city.names.ru }))}
            onChange={(cityId) => set({ cityId })}
          />
          <Period from={from} to={to} onChange={(patch) => set(patch)} />
        </div>
        <FlagChips<FlagKey>
          label="Отборы заявок"
          flags={FLAGS}
          isOn={(key) => query.get(key) === FLAGS.find((flag) => flag.key === key)?.value}
          onToggle={(key, on) =>
            set({ [key]: on ? FLAGS.find((flag) => flag.key === key)?.value : undefined })
          }
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
              icon="receipt"
              title={filtered ? "Заявок не найдено" : "Заявок пока нет"}
              text={filtered ? "Измените поиск или отборы" : undefined}
              action={
                filtered ? (
                  <Button variant="secondary" onClick={reset}>
                    Сбросить фильтры
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <OrdersTable orders={list.items} />
          )}
          <MoreOrders list={list} />
        </div>
      </LoadingContent>
    </>
  );
}

/** «Период» of a list: two dates of one filter, «с — по», days of Almaty. */
export function Period({
  from,
  to,
  onChange,
}: {
  from: string;
  to: string;
  onChange: (patch: { from?: string; to?: string }) => void;
}) {
  return (
    <fieldset className="period orders-period">
      <legend className="ac-field__label">Период</legend>
      <div className="period__fields">
        <DateField
          compact
          label="с"
          value={from}
          locale="ru"
          max={to || undefined}
          onChange={(next) => onChange({ from: next || undefined })}
        />
        <span className="period__dash" aria-hidden="true">
          —
        </span>
        <DateField
          compact
          label="по"
          value={to}
          locale="ru"
          min={from || undefined}
          onChange={(next) => onChange({ to: next || undefined })}
        />
      </div>
    </fieldset>
  );
}

/** «Показать ещё» of a paged list of the section and its error. */
export function MoreOrders<T extends { id: string }>({ list }: { list: Paged<T> }) {
  return (
    <>
      {list.moreError && <Banner tone="danger">{list.moreError}</Banner>}
      {list.next && (
        <Button variant="secondary" size="s" onClick={list.loadMore} loading={list.loadingMore}>
          Показать ещё
        </Button>
      )}
    </>
  );
}

/**
 * The rows of orders — the list, the supplier's and the user's tabs (X20:
 * fixed columns, the same on every one of them): the number with its kind,
 * the item, the customer, the supplier, the status with how it was closed,
 * the sum, when. The row opens the order (X1). `hide` leaves out a column
 * the page already says (the supplier on its card, the customer on theirs).
 */
export function OrdersTable({
  orders,
  hide = [],
}: {
  orders: readonly AdminOrderSummary[];
  hide?: readonly ("customer" | "supplier")[];
}) {
  const columns: Column[] = [
    { key: "number", header: "Номер", width: 112 },
    { key: "item", header: "Позиция" },
    ...(hide.includes("customer") ? [] : [{ key: "customer", header: "Клиент", width: 170 }]),
    ...(hide.includes("supplier") ? [] : [{ key: "supplier", header: "Поставщик", width: 150 }]),
    { key: "status", header: "Статус", width: 220 },
    { key: "total", header: "Сумма", width: 104, numeric: true },
    { key: "created", header: "Оформлена", width: 124 },
  ];
  return (
    <Table label="Заявки" columns={columns}>
      {orders.map((order) => {
        const href = orderPath(order.id);
        const kind = orderKindMark(order.kind);
        return (
          <tr key={order.id} {...rowLink(href)}>
            <td>
              <RowTitle href={href} sub={kind && <TypeMark icon={kind.icon}>{kind.text}</TypeMark>}>
                <span className="nowrap">№ {order.number}</span>
              </RowTitle>
            </td>
            <td>
              <div className="cell-stack">
                <span
                  className="cell-one-line orders-item ac-text-body-s"
                  title={order.item.name.text}
                >
                  {order.item.name.text}
                </span>
                <span className="ac-text-caption ac-muted cell-one-line">
                  {[
                    order.item.brand,
                    order.item.article,
                    order.kind === "service" ? null : `${order.quantity} шт.`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </div>
            </td>
            {!hide.includes("customer") && (
              <td>
                <div className="cell-stack">
                  <span
                    className="ac-text-body-s cell-one-line orders-cell"
                    title={order.customer.name ?? undefined}
                  >
                    {order.customer.name ?? <span className="ac-muted">Без имени</span>}
                  </span>
                  <span className="ac-text-caption ac-muted nowrap">{order.customer.phone}</span>
                </div>
              </td>
            )}
            {!hide.includes("supplier") && (
              <td className="ac-text-body-s">
                <span className="clamp" title={order.supplier.name}>
                  {order.supplier.name}
                </span>
              </td>
            )}
            <td>
              <div className="cell-stack">
                <StatusBadge kind="order" status={order.status}>
                  {orderStatusText(order)}
                </StatusBadge>
                <OrderMarks order={order} />
              </div>
            </td>
            <td className="num">{moneyText(order.total)}</td>
            <td className="ac-text-body-s nowrap">{formatMoment(order.createdAt)}</td>
          </tr>
        );
      })}
    </Table>
  );
}

/** «Тест», «Закрыта администратором», «Закрыта поздно» — quiet marks, not states (X7). */
export function OrderMarks({ order }: { order: Pick<AdminOrderSummary, "isTest" | "closure"> }) {
  const admin = order.closure?.method === "admin";
  const late = order.closure?.late === true && !admin;
  if (!order.isTest && !admin && !late) return null;
  return (
    <span className="badges">
      {order.isTest && <TypeMark icon="info">Тест</TypeMark>}
      {admin && <TypeMark icon="lock">Закрыта администратором</TypeMark>}
      {late && <TypeMark icon="clock">Закрыта поздно</TypeMark>}
    </span>
  );
}

/**
 * The chosen supplier of a filter, named from what was chosen here, else
 * from the rows, else from its card (an address opened from a link) —
 * shared with «Отзывы» (TASK-049).
 */
export function useSupplierChoice(
  supplierId: string | null,
  rows: readonly { supplier: { id: string; name: string } }[],
) {
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
