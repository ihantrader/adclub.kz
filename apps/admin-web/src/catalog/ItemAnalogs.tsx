import type { AdminCatalogItem, AdminCatalogItemCard } from "@adclub/contracts";
import { Banner, Button, EmptyState, SearchField, StatusBadge, useToast } from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useEffect, useState } from "react";
import { apiClient } from "../api";
import { RowTitle, rowLink, Table, Thumb } from "../layout/layout";
import { catalogItemPath } from "../router";
import { catalogErrorText } from "./catalog-words";
import { ruText } from "./values";

function itemLine(item: AdminCatalogItem): string {
  return [item.brand?.name, item.article].filter(Boolean).join(" · ");
}

const COLUMNS = [
  { key: "photo", header: "Фото", width: 64, hiddenHeader: true },
  { key: "analog", header: "Аналог" },
  { key: "link", header: "Связь", width: 160 },
  { key: "actions", header: "Действия", actions: true, hiddenHeader: true, width: 120 },
];

/**
 * «Аналоги» of the card (A-CAT-05; TASK-011, TASK-080): parts of the same
 * subcategory linked as analogs — added by a search, removed. Which pairs
 * may be linked the server decides (`CATALOG_ANALOG_INVALID` in words).
 */
export function ItemAnalogs({
  card,
  onChanged,
}: {
  card: AdminCatalogItemCard;
  onChanged: (card: AdminCatalogItemCard) => void;
}) {
  const toast = useToast();
  const online = useOnline();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ q: string; items: AdminCatalogItem[] }>({
    q: "",
    items: [],
  });
  const [error, setError] = useState<string | null>(null);
  const linked = new Set(card.analogs.map((analog) => analog.item.id));
  // Only the answer to what is typed now is shown.
  const answered = results.q !== "" && results.q === query.trim();
  const found = answered ? results.items.filter((item) => item.id !== card.item.id) : [];

  useEffect(() => {
    const q = query.trim();
    if (!q) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      apiClient
        .listAdminCatalogItems({
          query: { q, categoryId: card.item.categoryId, type: "part", limit: 10 },
        })
        .then(
          (page) => !cancelled && setResults({ q, items: page.items }),
          () => !cancelled && setResults({ q, items: [] }),
        );
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, card.item.categoryId]);

  const link = async (analogItemId: string) => {
    setError(null);
    try {
      onChanged(await apiClient.linkItemAnalog({ itemId: card.item.id }, { analogItemId }));
      toast.show("Аналог добавлен");
      setQuery("");
    } catch (thrown) {
      setError(catalogErrorText(thrown));
    }
  };

  const unlink = async (analogItemId: string) => {
    setError(null);
    try {
      onChanged(await apiClient.unlinkItemAnalog({ itemId: card.item.id, analogItemId }));
      toast.show("Связь убрана");
    } catch (thrown) {
      setError(catalogErrorText(thrown));
    }
  };

  return (
    <div className="detail-stack">
      {error && <Banner tone="warning">{error}</Banner>}
      <section className="section">
        <div className="section__head">
          <h3 className="section__title">Аналоги</h3>
        </div>
        {card.analogs.length === 0 ? (
          <EmptyState
            compact
            icon="package"
            title="Аналогов нет"
            text="Найдите запчасть той же подкатегории ниже и добавьте её как аналог"
          />
        ) : (
          <Table label="Аналоги позиции" columns={COLUMNS}>
            {card.analogs.map((analog) => {
              const href = catalogItemPath(analog.item.id);
              const name = ruText(analog.item.names) || "Без названия";
              return (
                <tr key={analog.item.id} {...rowLink(href)}>
                  <td>
                    <Thumb src={analog.item.photo?.thumbUrl} />
                  </td>
                  <td>
                    <RowTitle href={href} sub={itemLine(analog.item) || undefined}>
                      <span className="clamp" title={name}>
                        {name}
                      </span>
                    </RowTitle>
                  </td>
                  <td>
                    <StatusBadge kind="analog" status={analog.status}>
                      {analog.status === "approved" ? "Подтверждена" : "Предложена"}
                    </StatusBadge>
                  </td>
                  <td className="admin-table__actions">
                    <Button
                      variant="secondary"
                      size="s"
                      destructive
                      disabled={!online}
                      aria-label={`Убрать аналог «${name}»`}
                      onClick={() => void unlink(analog.item.id)}
                    >
                      Убрать
                    </Button>
                  </td>
                </tr>
              );
            })}
          </Table>
        )}
      </section>
      <section className="card cat-block">
        <div className="section__head">
          <h3 className="section__title">Добавить аналог</h3>
        </div>
        <SearchField
          label="Поиск запчасти той же подкатегории"
          placeholder="Артикул или название"
          value={query}
          onChange={setQuery}
          clearLabel="Очистить"
        />
        {found.length > 0 && (
          <ul className="pick-list">
            {found.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="pick-list__item cat-pick"
                  disabled={!online || linked.has(item.id)}
                  onClick={() => void link(item.id)}
                >
                  <span className="cell-stack">
                    <span className="ac-text-body-strong">{ruText(item.names)}</span>
                    <span className="ac-text-caption ac-muted">
                      {itemLine(item) || "—"}
                      {linked.has(item.id) ? " · уже аналог" : ""}
                    </span>
                  </span>
                  {!linked.has(item.id) && <span className="cat-pick__add">Добавить</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
        {answered && found.length === 0 && (
          <EmptyState compact icon="search" title="Ничего не нашлось" text="Измените запрос" />
        )}
      </section>
    </div>
  );
}
