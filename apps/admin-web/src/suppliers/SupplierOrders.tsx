import type { AdminOrderSummary, OrderStatusValue } from "@adclub/contracts";
import {
  Button,
  DateField,
  EmptyState,
  LoadingContent,
  SkeletonList,
  TableToolbar,
  todayIn,
} from "@adclub/ui";
import { apiClient } from "../api";
import { CLUB_TIME_ZONE } from "../format";
import { StatusChips } from "../layout/filters";
import { AppLink } from "../layout/layout";
import { ORDER_STATUS_TEXT, orderFiltersOf } from "../orders/order-words";
import { OrdersTable } from "../orders/Orders";
import { routePaths, withQuery } from "../router";
import { LoadError, usePaged } from "../vehicles/shared";
import { MoreButton, useAddressFilters } from "./shared";

/** The statuses worth a chip on a supplier's card; the rest — in «Заявки» with every filter. */
const STATUSES: OrderStatusValue[] = ["created", "accepted", "ready", "completed"];

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * «Заявки» of A-SUP-03 (SCREENS 7.4: «A-ORD-01 с отбором»; TASK-036,
 * TASK-036.B, TASK-080): the company's orders newest first, test ones too
 * (marked «Тест»), the status as chips and the period (days of Almaty) in
 * the address; each row opens the order (A-ORD-02); «Открыть в «Заявках»»
 * takes the same filters to the whole list. Never the code (SCREENS 7.0).
 */
export function SupplierOrders({ supplierId }: { supplierId: string }) {
  const { query, set } = useAddressFilters();
  const status = STATUSES.find((entry) => entry === query.get("status"));
  const from = DAY.test(query.get("from") ?? "") ? query.get("from")! : "";
  const to = DAY.test(query.get("to") ?? "") ? query.get("to")! : "";
  // The very rules of A-ORD-01 turn the address into the server's filters.
  const address = {
    supplierId,
    test: "include",
    status,
    from: from || undefined,
    to: to || undefined,
  };
  const filters = orderFiltersOf(
    new URLSearchParams(
      Object.entries(address).filter((entry): entry is [string, string] => Boolean(entry[1])),
    ),
  );
  const filtered = Boolean(status || from || to);
  const list = usePaged<AdminOrderSummary>(
    async (cursor) => {
      const page = await apiClient.listAdminOrders({ query: { ...filters, limit: 50, cursor } });
      return { items: page.orders, total: page.total, nextCursor: page.nextCursor };
    },
    `orders:${JSON.stringify(filters)}`,
  );
  const today = todayIn(CLUB_TIME_ZONE);

  return (
    <div className="detail-stack">
      <div className="filters__group">
        <div className="filters supplier-orders__filters">
          <DateField
            compact
            label="С"
            value={from}
            max={to || today}
            today={today}
            locale="ru"
            onChange={(date) => set({ from: date || undefined })}
          />
          <DateField
            compact
            label="По"
            value={to}
            min={from || undefined}
            max={today}
            today={today}
            locale="ru"
            onChange={(date) => set({ to: date || undefined })}
          />
          <span className="supplier-orders__link">
            <AppLink href={withQuery(routePaths.orders, address)}>Открыть в «Заявках» →</AppLink>
          </span>
        </div>
        <StatusChips<OrderStatusValue>
          label="Статус заявки"
          value={status}
          chips={STATUSES.map((value) => ({ value, label: ORDER_STATUS_TEXT[value] }))}
          onChange={(next) => set({ status: next })}
        />
      </div>
      <LoadError error={list.first.error} retry={list.first.reload} />
      <LoadingContent
        ready={list.first.data !== undefined}
        indicator={list.first.indicator}
        label="Загрузка"
        swapKey={list.first.answerKey}
        skeleton={<SkeletonList rows={4} label="Загрузка" />}
      >
        <div className="list-block">
          <TableToolbar total={list.items.length === 0 ? null : list.total}>
            {filtered && (
              <Button
                variant="text"
                size="s"
                onClick={() => set({ status: undefined, from: undefined, to: undefined })}
              >
                Сбросить фильтры
              </Button>
            )}
          </TableToolbar>
          {list.items.length === 0 ? (
            <EmptyState
              compact
              icon="receipt"
              title={filtered ? "Таких заявок нет" : "Заявок пока нет"}
              text={filtered ? "Измените статус или период" : undefined}
            />
          ) : (
            <OrdersTable orders={list.items} hide={["supplier"]} />
          )}
          <MoreButton list={list} />
        </div>
      </LoadingContent>
    </div>
  );
}
