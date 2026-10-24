import type { AdminSupplierCard, AdminSupplierResponse } from "@adclub/contracts";
import { IconButton, LoadingContent, SkeletonList } from "@adclub/ui";
import type { ReactNode } from "react";
import { apiClient } from "../api";
import { Header } from "../layout/layout";
import { supplierPath, useLocation, type SupplierTab } from "../router";
import { useLoad } from "../use-load";
import { LoadError } from "../vehicles/shared";
import { StateMark, SUPPLIERS_CRUMB } from "./shared";
import { SupplierHistory } from "./SupplierHistory";
import { SupplierMembers } from "./SupplierMembers";
import { SupplierOffers } from "./SupplierOffers";
import { SupplierOrders } from "./SupplierOrders";
import { SupplierPriceImports } from "./SupplierPriceImports";
import { SupplierProfile } from "./SupplierProfile";
import { SupplierStatuses } from "./SupplierStatuses";
import { SUPPLIER_TYPE_TEXT } from "./supplier-words";
import { SupplierRating } from "./SupplierRating";
import "./suppliers.css";

const TAB_TEXT: Record<SupplierTab, string> = {
  profile: "Профиль",
  statuses: "Статусы",
  members: "Сотрудники",
  offers: "Предложения",
  orders: "Заявки",
  rating: "Рейтинг и отзывы",
  price: "Прайс",
  history: "История",
};

const TABS = Object.keys(TAB_TEXT) as SupplierTab[];

/**
 * A-SUP-03 «Карточка поставщика» (SCREENS 7.4; TASK-036, TASK-080): the
 * crumbs of «Поставщики», the company as the title, its state and facts
 * under it, one bar of the card's tabs in the address (`?tab=`), so the
 * journal, the home page and a signal open the right one. «Рейтинг и
 * отзывы» — TASK-049, TASK-050 (`?tab=reviews` of before opens it too);
 * «Подписка», «Модерация» come later.
 */
export function SupplierCard({ supplierId }: { supplierId: string }) {
  const { query } = useLocation();
  const card = useLoad<AdminSupplierResponse>(
    () => apiClient.getAdminSupplier({ supplierId }),
    `supplier:${supplierId}`,
  );
  const data = card.data && card.data.supplier.id === supplierId ? card.data.supplier : undefined;
  const given = query.get("tab") ?? "profile";
  const asked = (given === "reviews" ? "rating" : given) as SupplierTab;
  const tab: SupplierTab = TABS.includes(asked) ? asked : "profile";
  const changed = (next: AdminSupplierCard) => card.replace({ supplier: next });

  let body: ReactNode = null;
  if (data) {
    switch (tab) {
      case "profile":
        body = <SupplierProfile card={data} onChanged={changed} onReload={card.reload} />;
        break;
      case "statuses":
        body = <SupplierStatuses card={data} onChanged={changed} onReload={card.reload} />;
        break;
      case "members":
        body = <SupplierMembers card={data} onReload={card.reload} />;
        break;
      case "offers":
        body = <SupplierOffers card={data} />;
        break;
      case "orders":
        body = <SupplierOrders supplierId={supplierId} />;
        break;
      case "rating":
        body = <SupplierRating supplierId={supplierId} />;
        break;
      case "price":
        body = <SupplierPriceImports supplierId={supplierId} />;
        break;
      case "history":
        body = <SupplierHistory supplierId={supplierId} />;
        break;
    }
  }

  return (
    <>
      <Header<SupplierTab>
        crumbs={[SUPPLIERS_CRUMB]}
        title={data ? data.name : "Поставщик"}
        subtitle={
          data && (
            <>
              <StateMark state={data.state} verified={data.verification !== null} />
              <span>
                {data.city.names.ru} · {SUPPLIER_TYPE_TEXT[data.type]}
              </span>
              {data.bin && <span>БИН {data.bin}</span>}
            </>
          )
        }
        actions={<IconButton icon="refresh" label="Обновить" size={20} onClick={card.reload} />}
        tabs={
          data
            ? {
                label: "Карточка поставщика",
                active: tab,
                items: TABS.map((entry) => ({
                  key: entry,
                  label: TAB_TEXT[entry],
                  href: supplierPath(supplierId, entry),
                })),
              }
            : undefined
        }
      />
      <LoadError error={card.error} retry={card.reload} />
      <LoadingContent
        ready={data !== undefined}
        indicator={card.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={6} label="Загрузка" />}
      >
        <div className="tab-body">{body}</div>
      </LoadingContent>
    </>
  );
}
