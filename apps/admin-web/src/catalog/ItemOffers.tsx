import type { AdminItemOffersResponse } from "@adclub/contracts";
import { Banner, EmptyState, LoadingContent, SkeletonList } from "@adclub/ui";
import { apiClient } from "../api";
import { loadErrorText } from "../errors";
import { useLoad } from "../use-load";
import { showcaseReasonText } from "./catalog-words";

const STATUS_TEXT: Record<string, string> = {
  active: "в продаже",
  suspended: "приостановлено",
  withdrawn: "снято",
};

/**
 * «Предложения» of the card (A-CAT-05), read only: whose offer, the price,
 * the availability, whether the showcase shows it and why not, the active
 * orders on it — every number from the server (`GET …/offers`).
 */
export function ItemOffers({ itemId }: { itemId: string }) {
  const data = useLoad<AdminItemOffersResponse>(
    () => apiClient.listAdminItemOffers({ itemId }),
    `offers:${itemId}`,
  );
  const offers = data.data?.offers ?? [];
  return (
    <div className="detail-stack">
      {data.error !== undefined && <Banner tone="danger">{loadErrorText(data.error)}</Banner>}
      <LoadingContent
        ready={data.data !== undefined}
        indicator={data.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={3} label="Загрузка" />}
      >
        {data.data && (
          <p className="ac-text-body-s">
            В продаже: {data.data.onSale} · активных заявок: {data.data.activeOrders}
          </p>
        )}
        {offers.length === 0 ? (
          <EmptyState
            icon="store"
            title="Предложений нет"
            text="Поставщики ещё не выставили эту позицию."
          />
        ) : (
          <div className="table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th scope="col">Поставщик</th>
                  <th scope="col" className="num">
                    Цена
                  </th>
                  <th scope="col">Наличие</th>
                  <th scope="col">Витрина</th>
                  <th scope="col" className="num">
                    Активные заявки
                  </th>
                </tr>
              </thead>
              <tbody>
                {offers.map((offer) => (
                  <tr
                    key={offer.id}
                    className={offer.status === "withdrawn" ? "row--muted" : undefined}
                  >
                    <td>
                      <div className="cell-stack">
                        <span className="ac-text-body-strong">{offer.supplier.name}</span>
                        <span className="ac-text-caption ac-muted">
                          {STATUS_TEXT[offer.status] ?? offer.status}
                        </span>
                      </div>
                    </td>
                    <td className="num">{offer.price.toLocaleString("ru-RU")} ₸</td>
                    <td className="ac-text-body-s">
                      {offer.availability === "in_stock"
                        ? "в наличии"
                        : `под заказ, ${offer.leadDays} дн.`}
                      {offer.pickup ? " · самовывоз" : ""}
                      {offer.delivery ? " · доставка" : ""}
                    </td>
                    <td className="ac-text-body-s">
                      {offer.showcase.visible ? (
                        "видно клиентам"
                      ) : (
                        <span className="warning-text">
                          не видно: {offer.showcase.reasons.map(showcaseReasonText).join(", ")}
                        </span>
                      )}
                    </td>
                    <td className="num">{offer.activeOrders}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </LoadingContent>
    </div>
  );
}
