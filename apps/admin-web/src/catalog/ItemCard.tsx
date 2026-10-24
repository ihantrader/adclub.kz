import type { AdminCatalogItemCard, CatalogItemStatus } from "@adclub/contracts";
import {
  Badge,
  Banner,
  Button,
  IconButton,
  LoadingContent,
  MenuButton,
  SkeletonList,
  StatusBadge,
  TypeMark,
  useToast,
  type MenuAction,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useState, type ReactNode } from "react";
import { apiClient } from "../api";
import { loadErrorText } from "../errors";
import { Header } from "../layout/layout";
import { catalogItemPath, useLocation } from "../router";
import { useLoad } from "../use-load";
import {
  catalogErrorText,
  conflictText,
  isConflict,
  ITEM_STATUS_TEXT,
  ITEM_TYPE_TEXT,
} from "./catalog-words";
import { ItemAnalogs } from "./ItemAnalogs";
import { ItemCompatibility } from "./ItemCompatibility";
import { ItemHistory } from "./ItemHistory";
import { ArchiveDialog, ItemMain } from "./ItemMain";
import { ItemOffers } from "./ItemOffers";
import { ItemPhotos } from "./ItemPhotos";
import { ItemTranslations } from "./ItemTranslations";
import { ItemValues } from "./ItemValues";
import { SearchSynonyms } from "./SearchSynonyms";
import { CATALOG_CRUMB, ITEMS_CRUMB, whoChanged } from "./shared";
import { ruText } from "./values";

type Tab =
  | "main"
  | "values"
  | "translations"
  | "photos"
  | "compatibility"
  | "analogs"
  | "search"
  | "offers"
  | "history";

const TAB_TEXT: Record<Tab, string> = {
  main: "Основное",
  values: "Характеристики",
  translations: "Переводы",
  photos: "Фото",
  compatibility: "Совместимость",
  analogs: "Аналоги",
  search: "Поиск",
  offers: "Предложения",
  history: "История",
};

const TYPE_ICON = { part: "package", generic: "tags", service: "wrench" } as const;

/** The tabs an item has: no compatibility for a service (the server keeps none), analogs only for parts. */
export function tabsOf(card: AdminCatalogItemCard): Tab[] {
  return (Object.keys(TAB_TEXT) as Tab[]).filter((tab) => {
    if (tab === "compatibility") return card.item.type !== "service";
    if (tab === "analogs") return card.item.type === "part";
    return true;
  });
}

/**
 * A-CAT-05 «Карточка позиции» (SCREENS 7.2; TASK-035, TASK-080): the crumbs
 * of «Справочник», the name, its status and type under it, the rarer
 * actions (the status) in «⋯» of the head; one bar of the item's tabs, in
 * the address (`?tab=`), so a link of the journal or of a list opens the
 * right one and «назад» works.
 */
export function ItemCard({ itemId }: { itemId: string }) {
  const { query } = useLocation();
  const toast = useToast();
  const online = useOnline();
  const card = useLoad<AdminCatalogItemCard>(
    () => apiClient.getAdminCatalogItem({ itemId }),
    `item:${itemId}`,
  );
  const [archiving, setArchiving] = useState(false);
  const [statusError, setStatusError] = useState<{ text: string; conflict: boolean } | null>(null);
  const data = card.data && card.data.item.id === itemId ? card.data : undefined;
  const tabs = data ? tabsOf(data) : [];
  const asked = (query.get("tab") ?? "main") as Tab;
  const tab: Tab = tabs.includes(asked) ? asked : "main";

  const setStatus = async (status: CatalogItemStatus) => {
    if (!data) return;
    setStatusError(null);
    try {
      card.replace(
        await apiClient.setCatalogItemStatus(
          { itemId },
          { status, expectedVersion: data.item.version },
        ),
      );
      toast.show(`Статус: ${ITEM_STATUS_TEXT[status].toLowerCase()}`);
    } catch (thrown) {
      setStatusError(
        isConflict(thrown)
          ? { text: conflictText(await whoChanged("catalog_item", itemId)), conflict: true }
          : { text: catalogErrorText(thrown), conflict: false },
      );
    } finally {
      setArchiving(false);
    }
  };

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
      case "search":
        body = (
          <section className="card cat-block">
            <div className="section__head">
              <h3 className="section__title">Синонимы для поиска</h3>
            </div>
            <SearchSynonyms
              owner={{ kind: "item", id: itemId }}
              intro="Синонимы этой позиции для поиска в приложении: по ним её найдут так же, как по названию. Синонимы её подкатегории — в дереве «Категории»."
            />
          </section>
        );
        break;
      case "offers":
        body = <ItemOffers itemId={itemId} />;
        break;
      case "history":
        body = <ItemHistory itemId={itemId} />;
        break;
    }
  }

  const item = data?.item;
  const statusActions: MenuAction[] = !item
    ? []
    : [
        ...(item.status !== "active"
          ? [
              {
                key: "active",
                label: item.status === "archived" ? "Восстановить" : "Сделать активной",
                icon: "circleCheck" as const,
                disabled: !online,
                onSelect: () => void setStatus("active"),
              },
            ]
          : []),
        ...(item.status === "active"
          ? [
              {
                key: "draft",
                label: "В черновик",
                icon: "clock" as const,
                disabled: !online,
                onSelect: () => void setStatus("draft"),
              },
            ]
          : []),
        ...(item.status !== "archived"
          ? [
              {
                key: "archive",
                label: "В архив…",
                icon: "archive" as const,
                destructive: true,
                disabled: !online,
                onSelect: () => setArchiving(true),
              },
            ]
          : []),
      ];

  return (
    <>
      <Header<Tab>
        crumbs={[CATALOG_CRUMB, ITEMS_CRUMB]}
        title={item ? ruText(item.names) || "Без названия" : "Позиция"}
        subtitle={
          item && (
            <>
              <StatusBadge kind="catalogItem" status={item.status}>
                {ITEM_STATUS_TEXT[item.status]}
              </StatusBadge>
              {item.completeness === "incomplete" && (
                <Badge tone="warning" icon="alertTriangle">
                  Неполная
                </Badge>
              )}
              <TypeMark icon={TYPE_ICON[item.type]}>{ITEM_TYPE_TEXT[item.type]}</TypeMark>
              {(item.brand || item.article) && (
                <span>{[item.brand?.name, item.article].filter(Boolean).join(" · ")}</span>
              )}
            </>
          )
        }
        actions={
          <>
            <IconButton icon="refresh" label="Обновить" size={20} onClick={card.reload} />
            {statusActions.length > 0 && (
              <MenuButton label="Действия с позицией" actions={statusActions} />
            )}
          </>
        }
        tabs={
          data
            ? {
                label: "Карточка позиции",
                active: tab,
                items: tabs.map((entry) => ({
                  key: entry,
                  label: TAB_TEXT[entry],
                  href: catalogItemPath(itemId, entry),
                })),
              }
            : undefined
        }
      />
      {statusError && (
        <Banner
          tone="warning"
          action={
            statusError.conflict ? (
              <Button
                variant="text"
                size="s"
                onClick={() => {
                  setStatusError(null);
                  card.reload();
                }}
              >
                Обновить данные
              </Button>
            ) : undefined
          }
        >
          {statusError.text}
        </Banner>
      )}
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
        <div className="tab-body">{body}</div>
      </LoadingContent>
      {item && (
        <ArchiveDialog
          itemId={archiving ? item.id : null}
          name={ruText(item.names)}
          status={item.status}
          onConfirm={() => setStatus("archived")}
          onCancel={() => setArchiving(false)}
        />
      )}
    </>
  );
}
