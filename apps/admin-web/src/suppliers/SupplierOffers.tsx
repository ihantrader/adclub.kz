import type { AdminSupplierCard, SupplierOffer } from "@adclub/contracts";
import { Banner, EmptyState, LoadingContent, SkeletonList } from "@adclub/ui";
import { apiClient } from "../api";
import { AppLink } from "../catalog/shared";
import { showcaseReasonText } from "../catalog/catalog-words";
import { formatMoment } from "../format";
import { catalogItemPath, supplierPath } from "../router";
import { LoadError, MoreButton, usePaged } from "../vehicles/shared";
import { useAddressFilters } from "./shared";

type OfferTab = "on_sale" | "withdrawn";

/** The reasons of the point's schedule (D-060): every offer of the point is hidden by them. */
const SCHEDULE_REASONS = new Set(["hours_not_set", "no_working_day"]);

/**
 * «Предложения» of A-SUP-03 (TASK-036), read only: «В продаже» and
 * «Снятые» with the server's counts, the item (a link to the catalog), the
 * price, the availability, whether clients see it and why not — the
 * showcase's reasons, all of them (a pause and no hours are both said).
 */
export function SupplierOffers({ card }: { card: AdminSupplierCard }) {
  const { query, set } = useAddressFilters();
  const tab: OfferTab = query.get("offers") === "withdrawn" ? "withdrawn" : "on_sale";
  const list = usePaged<SupplierOffer>(async (cursor) => {
    const page = await apiClient.listAdminSupplierOffers(
      { supplierId: card.id },
      { query: { tab, limit: 50, cursor } },
    );
    return {
      items: page.offers,
      total: page.total,
      nextCursor: page.nextCursor,
      counts: page.counts,
    };
  }, `offers:${card.id}:${tab}`);
  const counts = (list.first.data as { counts?: { onSale: number; withdrawn: number } } | undefined)
    ?.counts;
  const reasons = new Set(list.items.flatMap((offer) => offer.showcase.reasons));
  const scheduleHides = [...reasons].some((reason) => SCHEDULE_REASONS.has(reason));

  return (
    <div className="detail-stack">
      <nav className="chips funnel-tabs" aria-label="Предложения">
        {(["on_sale", "withdrawn"] as const).map((key) => (
          <button
            key={key}
            type="button"
            className={key === tab ? "funnel-tab funnel-tab--on" : "funnel-tab"}
            aria-pressed={key === tab}
            onClick={() => set({ offers: key === "on_sale" ? undefined : key })}
          >
            {key === "on_sale" ? "В продаже" : "Снятые"}
            {counts && (
              <span className="funnel-tab__count">
                {key === "on_sale" ? counts.onSale : counts.withdrawn}
              </span>
            )}
          </button>
        ))}
      </nav>
      {card.state !== "active" && (
        <Banner tone="warning">
          {card.state === "blocked" ? "Компания заблокирована" : "Компания на паузе"} — её
          предложения не видны клиентам, пока это не снято (вкладка «Статусы»).
        </Banner>
      )}
      {(scheduleHides || card.schedule.weeklyHours === null) && (
        <Banner tone="warning">
          Без часов работы предложения не показываются клиентам ·{" "}
          <AppLink href={supplierPath(card.id)}>Профиль: часы работы</AppLink>
        </Banner>
      )}
      <LoadError error={list.first.error} retry={list.first.reload} />
      <LoadingContent
        ready={list.first.data !== undefined}
        indicator={list.first.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={4} label="Загрузка" />}
      >
        {list.items.length === 0 ? (
          <EmptyState
            icon="store"
            title={tab === "on_sale" ? "Предложений в продаже нет" : "Снятых предложений нет"}
            text="Предложения выставляет сам поставщик в кабинете."
          />
        ) : (
          <div className="table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th scope="col">Позиция</th>
                  <th scope="col" className="num">
                    Цена
                  </th>
                  <th scope="col">Наличие</th>
                  <th scope="col">Видно клиентам</th>
                  <th scope="col">Изменено</th>
                </tr>
              </thead>
              <tbody>
                {list.items.map((offer) => (
                  <tr key={offer.id}>
                    <td>
                      <div className="cell-stack">
                        <span className="long-text" title={offer.item.name.text}>
                          <AppLink href={catalogItemPath(offer.item.id)}>
                            {offer.item.name.text}
                          </AppLink>
                        </span>
                        <span className="ac-text-caption ac-muted">
                          {[offer.item.brand?.name, offer.item.article].filter(Boolean).join(" · ")}
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
                        "да"
                      ) : (
                        <span className="warning-text">
                          нет: {offer.showcase.reasons.map(showcaseReasonText).join(", ")}
                        </span>
                      )}
                    </td>
                    <td className="ac-text-body-s num">{formatMoment(offer.updatedAt)}</td>
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
