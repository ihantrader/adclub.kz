import type { AdminOrderSummary } from "@adclub/contracts";
import { EmptyState, LoadingContent, SkeletonList } from "@adclub/ui";
import { apiClient } from "../api";
import { formatMoment } from "../format";
import { LoadError, MoreButton, usePaged } from "../vehicles/shared";
import { ORDER_STATUS_TEXT } from "./supplier-words";

/**
 * «Заявки» of A-SUP-03 (TASK-036), read only: the company's orders — the
 * number, the item, the status, when — newest first, test orders too
 * (marked). The full section with the card and its actions is TASK-036.B;
 * until then the number is not a link. Never the code (SCREENS 7.0), and
 * no customer data here.
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
      <p className="ac-text-body-s ac-muted">
        Карточка заявки и действия с ней появятся в разделе «Заявки» (TASK-036.B).
      </p>
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
          <div className="table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th scope="col">Номер</th>
                  <th scope="col">Позиция</th>
                  <th scope="col">Статус</th>
                  <th scope="col" className="num">
                    Сумма
                  </th>
                  <th scope="col">Оформлена</th>
                </tr>
              </thead>
              <tbody>
                {list.items.map((order) => (
                  <tr key={order.id}>
                    <td className="num nowrap">
                      № {order.number}
                      {order.isTest && (
                        <span className="ac-text-caption ac-muted"> · тестовая</span>
                      )}
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
                    <td className="ac-text-body-s">{ORDER_STATUS_TEXT[order.status]}</td>
                    <td className="num">{order.total.toLocaleString("ru-RU")} ₸</td>
                    <td className="ac-text-body-s num">{formatMoment(order.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <MoreButton list={list} />
      </LoadingContent>
    </div>
  );
}
