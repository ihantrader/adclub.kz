import type { AdminItemOffer, AdminItemOffersResponse } from "@adclub/contracts";
import {
  Badge,
  Banner,
  Button,
  EmptyState,
  LoadingContent,
  SkeletonList,
  StatusBadge,
  TableToolbar,
} from "@adclub/ui";
import { apiClient } from "../api";
import { loadErrorText } from "../errors";
import { formatMoney } from "../format";
import { RowTitle, rowLink, Table } from "../layout/layout";
import { supplierPath } from "../router";
import { useLoad } from "../use-load";
import { offerPriceText, offerTermsText, showcaseReasonText } from "./catalog-words";

const STATUS_TEXT: Record<AdminItemOffer["status"], string> = {
  active: "В продаже",
  suspended: "Приостановлено",
  withdrawn: "Снято",
};

const COLUMNS = [
  { key: "supplier", header: "Поставщик" },
  { key: "price", header: "Цена", width: 140, numeric: true },
  { key: "terms", header: "Наличие и получение", width: 190 },
  { key: "orders", header: "Активные заявки", width: 140, numeric: true },
];

/** «12 500 ₸», a service by model — «от 8 000 ₸ · 2 модели» (the models in the hint). */
function priceCell(offer: AdminItemOffer): { text: string; title?: string } {
  if (offer.pricing.mode === "single") return { text: formatMoney(offer.price) };
  const count = offer.pricing.models.length;
  const models = count === 1 ? "модель" : count < 5 ? "модели" : "моделей";
  return {
    text: `от ${formatMoney(offer.price)} · ${String(count)} ${models}`,
    title: offerPriceText(offer),
  };
}

/**
 * «Предложения» of the card (A-CAT-05; TASK-080), read only: whose offer,
 * the price, the availability, whether the showcase shows it — only «Не
 * видно» with its reasons is marked — and the active orders on it; every
 * number from the server (`GET …/offers`). A row opens the supplier.
 */
export function ItemOffers({ itemId }: { itemId: string }) {
  const data = useLoad<AdminItemOffersResponse>(
    () => apiClient.listAdminItemOffers({ itemId }),
    `offers:${itemId}`,
  );
  const offers = data.data?.offers ?? [];
  return (
    <div className="detail-stack">
      {data.error !== undefined && (
        <Banner
          tone="danger"
          action={
            <Button variant="text" size="s" onClick={data.reload}>
              Повторить
            </Button>
          }
        >
          {loadErrorText(data.error)}
        </Banner>
      )}
      <LoadingContent
        ready={data.data !== undefined}
        indicator={data.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={3} label="Загрузка" />}
      >
        {offers.length === 0 ? (
          <EmptyState
            compact
            icon="store"
            title="Предложений нет"
            text="Поставщики ещё не выставили эту позицию."
          />
        ) : (
          <div className="list-block">
            <TableToolbar total={offers.length}>
              {data.data && (
                <span className="ac-text-body-s ac-muted">
                  В продаже {data.data.onSale} · активных заявок {data.data.activeOrders}
                </span>
              )}
            </TableToolbar>
            <Table label="Предложения поставщиков на позицию" columns={COLUMNS}>
              {offers.map((offer) => {
                const price = priceCell(offer);
                const link = rowLink(supplierPath(offer.supplier.id));
                return (
                  <tr
                    key={offer.id}
                    {...link}
                    className={
                      offer.status === "withdrawn" ? `${link.className} row--muted` : link.className
                    }
                  >
                    <td>
                      <div className="cell-stack cat-badge-wrap">
                        <RowTitle href={supplierPath(offer.supplier.id)}>
                          {offer.supplier.name}
                        </RowTitle>
                        {offer.status !== "active" && (
                          <StatusBadge kind="offer" status={offer.status}>
                            {STATUS_TEXT[offer.status]}
                          </StatusBadge>
                        )}
                        {!offer.showcase.visible && (
                          <Badge tone="warning" icon="alertTriangle">
                            Не видно клиентам:{" "}
                            {offer.showcase.reasons.map(showcaseReasonText).join(", ")}
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td className="num" title={price.title}>
                      {price.text}
                    </td>
                    <td className="ac-text-body-s">{offerTermsText(offer)}</td>
                    <td className="num">
                      {offer.activeOrders > 0 ? offer.activeOrders.toLocaleString("ru-RU") : "—"}
                    </td>
                  </tr>
                );
              })}
            </Table>
          </div>
        )}
      </LoadingContent>
    </div>
  );
}
