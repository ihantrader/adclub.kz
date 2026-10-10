import type { AdminOrderSummary } from "@adclub/contracts";
import { Button, EmptyState, LoadingContent, SkeletonList } from "@adclub/ui";
import { apiClient } from "../api";
import { OrdersTable } from "../orders/Orders";
import { navigateTo, routePaths, withQuery } from "../router";
import { LoadError, MoreButton, usePaged } from "../vehicles/shared";

/**
 * «Заявки» of A-SUP-03 (SCREENS 7.4: «A-ORD-01 с отбором»; TASK-036,
 * TASK-036.B): the company's orders newest first, test ones too (marked),
 * each opening its card (A-ORD-02); the whole list with every filter is
 * «Заявки» with this supplier chosen. Never the code (SCREENS 7.0).
 */
export function SupplierOrders({ supplierId }: { supplierId: string }) {
  const list = usePaged<AdminOrderSummary>(async (cursor) => {
    const page = await apiClient.listAdminOrders({
      query: { supplierId, test: "include", limit: 50, cursor },
    });
    return { items: page.orders, total: page.total, nextCursor: page.nextCursor };
  }, `orders:${supplierId}`);
  return (
    <div className="detail-stack">
      <div className="button-row">
        <Button
          variant="secondary"
          size="s"
          onClick={() => navigateTo(withQuery(routePaths.orders, { supplierId, test: "include" }))}
        >
          Все отборы в разделе «Заявки»
        </Button>
      </div>
      <LoadError error={list.first.error} retry={list.first.reload} />
      <LoadingContent
        ready={list.first.data !== undefined}
        indicator={list.first.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={4} label="Загрузка" />}
      >
        <p className="ac-text-body-s ac-muted">Всего: {list.total.toLocaleString("ru-RU")}</p>
        {list.items.length === 0 ? (
          <EmptyState icon="receipt" title="Заявок пока нет" />
        ) : (
          <OrdersTable orders={list.items} hide={["supplier"]} />
        )}
        <MoreButton list={list} />
      </LoadingContent>
    </div>
  );
}
