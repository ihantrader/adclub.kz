import type { AdminSupplierCard, AdminSupplierResponse } from "@adclub/contracts";
import { Button, IconButton, LoadingContent, SkeletonList } from "@adclub/ui";
import type { ReactNode } from "react";
import { apiClient } from "../api";
import { JournalHistory } from "../audit/JournalHistory";
import { follow } from "../catalog/shared";
import { goBack, supplierPath, useLocation, type SupplierTab } from "../router";
import { useLoad } from "../use-load";
import { LoadError } from "../vehicles/shared";
import { StateMark, SuppliersTabs } from "./shared";
import { SupplierMembers } from "./SupplierMembers";
import { SupplierOffers } from "./SupplierOffers";
import { SupplierOrders } from "./SupplierOrders";
import { SupplierProfile } from "./SupplierProfile";
import { SupplierStatuses } from "./SupplierStatuses";
import { SUPPLIER_TYPE_TEXT } from "./supplier-words";

const TAB_TEXT: Record<SupplierTab, string> = {
  profile: "Профиль",
  statuses: "Статусы",
  members: "Сотрудники",
  offers: "Предложения",
  orders: "Заявки",
  history: "История",
};

const TABS = Object.keys(TAB_TEXT) as SupplierTab[];

/**
 * A-SUP-03 «Карточка поставщика» (SCREENS 7.4; TASK-036): the tabs in the
 * address (`?tab=`), so the journal, the home page and a signal open the
 * right one. «Рейтинг и отзывы», «Подписка», «Модерация» come with stages C–D.
 */
export function SupplierCard({ supplierId }: { supplierId: string }) {
  const { query } = useLocation();
  const card = useLoad<AdminSupplierResponse>(
    () => apiClient.getAdminSupplier({ supplierId }),
    `supplier:${supplierId}`,
  );
  const data = card.data && card.data.supplier.id === supplierId ? card.data.supplier : undefined;
  const asked = (query.get("tab") ?? "profile") as SupplierTab;
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
      case "history":
        body = (
          <JournalHistory
            filter={{ supplierId }}
            loadKey={`supplier-history:${supplierId}`}
            caption="История поставщика"
          />
        );
        break;
    }
  }

  return (
    <>
      <div className="page__head page__head--back">
        <IconButton
          icon="arrowLeft"
          label="Назад к поставщикам"
          onClick={() => goBack("suppliers")}
        />
        <div className="cell-stack supplier-head">
          <h1 className="ac-text-title-l page__title long-text" title={data?.name}>
            {data ? data.name : "Поставщик"}
          </h1>
          {data && (
            <span className="supplier-head__line ac-text-body-s ac-muted">
              <StateMark state={data.state} verified={data.verification !== null} />
              <span>
                {data.city.names.ru} · {SUPPLIER_TYPE_TEXT[data.type]}
                {data.bin ? ` · БИН ${data.bin}` : ""}
              </span>
            </span>
          )}
        </div>
        <Button variant="secondary" size="s" icon="refresh" onClick={card.reload}>
          Обновить
        </Button>
      </div>
      <SuppliersTabs active={null} />
      <LoadError error={card.error} retry={card.reload} />
      <LoadingContent
        ready={data !== undefined}
        indicator={card.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={6} label="Загрузка" />}
      >
        <nav className="page-tabs" aria-label="Карточка поставщика">
          {TABS.map((entry) => {
            const href = supplierPath(supplierId, entry);
            return (
              <a
                key={entry}
                href={href}
                className={entry === tab ? "page-tabs__tab page-tabs__tab--on" : "page-tabs__tab"}
                aria-current={entry === tab ? "page" : undefined}
                onClick={(event) => follow(event, href)}
              >
                {TAB_TEXT[entry]}
              </a>
            );
          })}
        </nav>
        <div className="tab-body">{body}</div>
      </LoadingContent>
    </>
  );
}
