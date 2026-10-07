import type { AdminCatalogItem, AdminCatalogItemCard } from "@adclub/contracts";
import { Banner, Button, SearchField, useToast } from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useEffect, useState } from "react";
import { apiClient } from "../api";
import { catalogItemPath } from "../router";
import { catalogErrorText } from "./catalog-words";
import { AppLink } from "./shared";
import { ruText } from "./values";

function itemLine(item: AdminCatalogItem): string {
  return [item.brand?.name, item.article].filter(Boolean).join(" · ");
}

/**
 * «Аналоги» of the card (A-CAT-05; TASK-011): parts of the same
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
  const found = results.q && results.q === query.trim() ? results.items : [];

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
      {card.analogs.length === 0 ? (
        <p className="ac-text-body-s ac-muted">Аналогов нет.</p>
      ) : (
        <div className="table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th scope="col">Аналог</th>
                <th scope="col">Связь</th>
                <th scope="col" className="admin-table__actions">
                  Действия
                </th>
              </tr>
            </thead>
            <tbody>
              {card.analogs.map((analog) => (
                <tr key={analog.item.id}>
                  <td>
                    <div className="cell-stack">
                      <AppLink href={catalogItemPath(analog.item.id)}>
                        <span className="clamp">{ruText(analog.item.names)}</span>
                      </AppLink>
                      <span className="ac-text-caption ac-muted">{itemLine(analog.item)}</span>
                    </div>
                  </td>
                  <td className="ac-text-body-s">
                    {analog.status === "approved" ? "подтверждена" : "предложена"}
                  </td>
                  <td className="admin-table__actions">
                    <Button
                      variant="text"
                      size="s"
                      disabled={!online}
                      onClick={() => unlink(analog.item.id)}
                    >
                      Убрать
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="card-section">
        <h3 className="ac-text-heading">Добавить аналог</h3>
        <p className="ac-text-body-s ac-muted">
          Запчасти той же подкатегории, по артикулу или названию.
        </p>
        <SearchField
          label="Артикул или название"
          value={query}
          onChange={setQuery}
          clearLabel="Очистить"
        />
        {found.length > 0 && (
          <ul className="pick-list">
            {found
              .filter((item) => item.id !== card.item.id)
              .map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className="pick-list__item"
                    disabled={!online || linked.has(item.id)}
                    onClick={() => link(item.id)}
                  >
                    <span className="ac-text-body-strong">{ruText(item.names)}</span>
                    <span className="ac-text-caption ac-muted">
                      {" "}
                      · {itemLine(item)}
                      {linked.has(item.id) ? " · уже аналог" : ""}
                    </span>
                  </button>
                </li>
              ))}
          </ul>
        )}
        {query.trim() && found.length === 0 && (
          <span className="ac-text-caption ac-muted">Ничего не нашлось</span>
        )}
      </div>
    </div>
  );
}
