import type { AdminSupplierCard, SupplierOffer } from "@adclub/contracts";
import {
  Badge,
  Banner,
  Button,
  EmptyState,
  LoadingContent,
  SkeletonList,
  TableToolbar,
  TypeMark,
} from "@adclub/ui";
import { apiClient } from "../api";
import { offerTermsText, showcaseReasonText } from "../catalog/catalog-words";
import { formatMoment, formatMoney } from "../format";
import { StatusChips } from "../layout/filters";
import { Muted, RowTitle, rowLink, Table } from "../layout/layout";
import { catalogItemPath, navigateTo, supplierPath } from "../router";
import { LoadError, usePaged } from "../vehicles/shared";
import { MoreButton, useAddressFilters } from "./shared";
import { offerModelsText, offerPriceLine } from "./supplier-words";

type OfferTab = "on_sale" | "withdrawn";

/** The reasons of the point's schedule (D-060): every offer of the point is hidden by them. */
const SCHEDULE_REASONS = new Set(["hours_not_set", "no_working_day"]);

const COLUMNS = [
  { key: "item", header: "Позиция" },
  { key: "price", header: "Цена", width: 140, numeric: true },
  { key: "terms", header: "Наличие", width: 240 },
  { key: "showcase", header: "Витрина", width: 200 },
  { key: "updated", header: "Изменено", width: 140 },
];

/**
 * «Предложения» of A-SUP-03 (TASK-036, TASK-080), read only: «В продаже» and
 * «Снятые» as chips with the server's counts; the whole row opens the
 * item; the price on the right («от 8 000 ₸ · 2 модели» for a service with
 * prices by model, the models in the hint); only an offer clients don't see
 * is marked — «Не видно» with the showcase's reasons, all of them (a pause
 * and no hours are both said).
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
      <StatusChips<OfferTab>
        label="Предложения"
        value={tab}
        allLabel={null}
        chips={[
          { value: "on_sale", label: "В продаже", count: counts?.onSale ?? null },
          { value: "withdrawn", label: "Снятые", count: counts?.withdrawn ?? null },
        ]}
        onChange={(next) => set({ offers: next === "withdrawn" ? next : undefined })}
      />
      {card.state !== "active" && (
        <Banner tone="warning">
          {card.state === "blocked" ? "Компания заблокирована" : "Компания на паузе"} — её
          предложения не видны клиентам, пока это не снято (вкладка «Статусы»).
        </Banner>
      )}
      {(scheduleHides || card.schedule.weeklyHours === null) && (
        <Banner
          tone="warning"
          action={
            <Button variant="text" size="s" onClick={() => navigateTo(supplierPath(card.id))}>
              Профиль: часы работы
            </Button>
          }
        >
          Без часов работы предложения не показываются клиентам
        </Banner>
      )}
      <LoadError error={list.first.error} retry={list.first.reload} />
      <LoadingContent
        ready={list.first.data !== undefined}
        indicator={list.first.indicator}
        label="Загрузка"
        swapKey={list.first.answerKey}
        skeleton={<SkeletonList rows={4} label="Загрузка" />}
      >
        <div className="list-block">
          <TableToolbar total={list.items.length === 0 ? null : list.total} />
          {list.items.length === 0 ? (
            <EmptyState
              compact
              icon="store"
              title={tab === "on_sale" ? "Предложений в продаже нет" : "Снятых предложений нет"}
              text="Предложения выставляет сам поставщик в кабинете"
            />
          ) : (
            <Table label="Предложения поставщика" columns={COLUMNS}>
              {list.items.map((offer) => {
                const href = catalogItemPath(offer.item.id);
                const models = offerModelsText(offer);
                return (
                  <tr key={offer.id} {...rowLink(href)}>
                    <td>
                      <RowTitle
                        href={href}
                        sub={
                          offer.item.type === "service" ? (
                            <TypeMark icon="wrench">Услуга</TypeMark>
                          ) : (
                            [offer.item.brand?.name, offer.item.article]
                              .filter(Boolean)
                              .join(" · ") || undefined
                          )
                        }
                      >
                        <span className="clamp" title={offer.item.name.text}>
                          {offer.item.name.text}
                        </span>
                      </RowTitle>
                    </td>
                    <td className="num">
                      <span className="cell-stack">
                        <span title={models ?? undefined}>
                          {offer.pricing.mode === "single" ? "" : "от "}
                          {formatMoney(offer.price)}
                        </span>
                        {offer.pricing.mode !== "single" && (
                          <span className="row-title__sub" title={models ?? undefined}>
                            {offerPriceLine(offer)}
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="ac-text-body-s">{offerTermsText(offer)}</td>
                    <td>
                      {offer.showcase.visible ? (
                        <Muted>—</Muted>
                      ) : (
                        <span className="cell-stack">
                          <span className="badges">
                            <Badge tone="warning" icon="eye">
                              Не видно клиентам
                            </Badge>
                          </span>
                          <span className="row-title__sub">
                            {offer.showcase.reasons.map(showcaseReasonText).join(", ")}
                          </span>
                        </span>
                      )}
                    </td>
                    <td className="ac-text-body-s nowrap">{formatMoment(offer.updatedAt)}</td>
                  </tr>
                );
              })}
            </Table>
          )}
          <MoreButton list={list} />
        </div>
      </LoadingContent>
    </div>
  );
}
