import type { AdminCatalogItemCard } from "@adclub/contracts";
import { Banner, Button, LoadingContent, SkeletonList } from "@adclub/ui";
import type { ReactNode } from "react";
import { apiClient } from "../api";
import { loadErrorText } from "../errors";
import { catalogItemPath, useLocation } from "../router";
import { useLoad } from "../use-load";
import { ITEM_STATUS_TEXT, ITEM_TYPE_TEXT } from "./catalog-words";
import { ItemAnalogs } from "./ItemAnalogs";
import { ItemCompatibility } from "./ItemCompatibility";
import { ItemHistory } from "./ItemHistory";
import { ItemMain } from "./ItemMain";
import { ItemOffers } from "./ItemOffers";
import { ItemPhotos } from "./ItemPhotos";
import { ItemTranslations } from "./ItemTranslations";
import { ItemValues } from "./ItemValues";
import { CatalogTabs, follow } from "./shared";
import { ruText } from "./values";

type Tab =
  | "main"
  | "values"
  | "translations"
  | "photos"
  | "compatibility"
  | "analogs"
  | "offers"
  | "history";

const TAB_TEXT: Record<Tab, string> = {
  main: "Основное",
  values: "Характеристики",
  translations: "Переводы",
  photos: "Фото",
  compatibility: "Совместимость",
  analogs: "Аналоги",
  offers: "Предложения",
  history: "История",
};

/** The tabs an item has: no compatibility for a service (the server keeps none), analogs only for parts. */
export function tabsOf(card: AdminCatalogItemCard): Tab[] {
  return (Object.keys(TAB_TEXT) as Tab[]).filter((tab) => {
    if (tab === "compatibility") return card.item.type !== "service";
    if (tab === "analogs") return card.item.type === "part";
    return true;
  });
}

/**
 * A-CAT-05 «Карточка позиции» (SCREENS 7.2; TASK-035): the tabs in the
 * address (`?tab=`), so a link of the journal or of a list opens the right
 * one and «назад» works.
 */
export function ItemCard({ itemId }: { itemId: string }) {
  const { query } = useLocation();
  const card = useLoad<AdminCatalogItemCard>(
    () => apiClient.getAdminCatalogItem({ itemId }),
    `item:${itemId}`,
  );
  const data = card.data && card.data.item.id === itemId ? card.data : undefined;
  const tabs = data ? tabsOf(data) : [];
  const asked = (query.get("tab") ?? "main") as Tab;
  const tab: Tab = tabs.includes(asked) ? asked : "main";

  let body: ReactNode = null;
  if (data) {
    switch (tab) {
      case "main":
        body = <ItemMain card={data} onChanged={card.replace} onReload={card.reload} />;
        break;
      case "values":
        body = <ItemValues card={data} onChanged={card.replace} onReload={card.reload} />;
        break;
      case "translations":
        body = <ItemTranslations card={data} onChanged={card.reload} />;
        break;
      case "photos":
        body = <ItemPhotos card={data} onChanged={card.reload} />;
        break;
      case "compatibility":
        body = <ItemCompatibility card={data} />;
        break;
      case "analogs":
        body = <ItemAnalogs card={data} onChanged={card.replace} />;
        break;
      case "offers":
        body = <ItemOffers itemId={itemId} />;
        break;
      case "history":
        body = <ItemHistory itemId={itemId} />;
        break;
    }
  }

  return (
    <>
      <div className="page__head">
        <div className="cell-stack">
          <h1 className="ac-text-title-l page__title">
            {data ? ruText(data.item.names) || "Без названия" : "Позиция"}
          </h1>
          {data && (
            <span className="ac-text-body-s ac-muted">
              {ITEM_TYPE_TEXT[data.item.type]}
              {data.item.brand ? ` · ${data.item.brand.name}` : ""}
              {data.item.article ? ` · ${data.item.article}` : ""} ·{" "}
              {ITEM_STATUS_TEXT[data.item.status]}
              {data.item.completeness === "incomplete" ? " · неполная" : ""}
            </span>
          )}
        </div>
        <Button variant="secondary" size="s" icon="refresh" onClick={card.reload}>
          Обновить
        </Button>
      </div>
      <CatalogTabs active={null} />
      {card.error !== undefined && (
        <Banner
          tone="danger"
          action={
            <Button variant="text" size="s" onClick={card.reload}>
              Повторить
            </Button>
          }
        >
          {loadErrorText(card.error)}
        </Banner>
      )}
      <LoadingContent
        ready={data !== undefined}
        indicator={card.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={6} label="Загрузка" />}
      >
        <nav className="page-tabs" aria-label="Карточка позиции">
          {tabs.map((entry) => {
            const href = catalogItemPath(itemId, entry);
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
