import { isApiError } from "@adclub/api-client";
import {
  catalogValuesRejectedDetailsSchema,
  type AdminCatalogItemCard,
  type AttributeValue,
  type ItemValueInput,
} from "@adclub/contracts";
import { Banner, Button, EmptyState, useToast } from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useState } from "react";
import { apiClient } from "../api";
import { routePaths, withQuery } from "../router";
import { catalogErrorText, conflictText, isConflict } from "./catalog-words";
import { CellEditor } from "./Fill";
import { rejectionText } from "./fill-state";
import { AppLink, whoChanged } from "./shared";
import { numberHint, parseValue, ruText, sameValue, valueInput, valueText } from "./values";

/**
 * «Характеристики» of the card (A-CAT-05): every active characteristic of
 * the subcategory, empty ones shown as such, those that count for
 * completeness marked; saved together with the item's version, refusals at
 * their characteristic.
 */
export function ItemValues({
  card,
  onChanged,
  onReload,
}: {
  card: AdminCatalogItemCard;
  onChanged: (card: AdminCatalogItemCard) => void;
  onReload: () => void;
}) {
  const toast = useToast();
  const online = useOnline();
  const [drafts, setDrafts] = useState<Map<string, string>>(new Map());
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [banner, setBanner] = useState<{ text: string; conflict: boolean } | null>(null);
  const stored = (attributeId: string): AttributeValue =>
    card.values.find((entry) => entry.attributeId === attributeId)?.value ?? null;
  const missing = new Set(card.missingAttributeIds);

  if (card.attributes.length === 0) {
    return (
      <EmptyState
        icon="checklist"
        title="У подкатегории нет характеристик"
        text="Позиция описывается названием, брендом и артикулом. Характеристики добавляются в разделе «Категории»."
        action={
          <AppLink href={withQuery(routePaths.catalog, { node: card.category.id })}>
            Открыть подкатегорию
          </AppLink>
        }
      />
    );
  }

  const save = async () => {
    const values: ItemValueInput[] = [];
    const invalid = new Map<string, string>();
    for (const [attributeId, raw] of drafts) {
      const attribute = card.attributes.find((entry) => entry.id === attributeId);
      if (!attribute) continue;
      const parsed = parseValue(attribute, raw);
      if ("error" in parsed) invalid.set(attributeId, parsed.error);
      else if (!sameValue(parsed.value, stored(attributeId))) {
        values.push({ attributeId, value: parsed.value });
      }
    }
    setErrors(invalid);
    if (invalid.size > 0) return;
    if (values.length === 0) {
      toast.show("Изменений нет");
      return;
    }
    setBanner(null);
    try {
      onChanged(
        await apiClient.setCatalogItemValues(
          { itemId: card.item.id },
          { expectedVersion: card.item.version, values },
        ),
      );
      setDrafts(new Map());
      toast.show("Сохранено");
    } catch (thrown) {
      if (isApiError(thrown) && thrown.code === "CATALOG_VALUES_REJECTED") {
        const details = catalogValuesRejectedDetailsSchema.safeParse(thrown.details);
        const placed = new Map<string, string>();
        for (const rejection of details.success ? details.data.rejections : []) {
          const attributeId = values[rejection.index]?.attributeId ?? rejection.attributeId;
          placed.set(attributeId, rejectionText(rejection));
        }
        setErrors(placed);
        setBanner({ text: "Ничего не сохранено — ошибки у полей", conflict: false });
      } else if (isConflict(thrown)) {
        setBanner({
          text: conflictText(await whoChanged("catalog_item", card.item.id)),
          conflict: true,
        });
      } else {
        setBanner({ text: catalogErrorText(thrown), conflict: false });
      }
    }
  };

  return (
    <div className="detail-stack">
      <div className="table-wrap">
        <table className="admin-table values-table">
          <thead>
            <tr>
              <th scope="col">Характеристика</th>
              <th scope="col">Значение</th>
              <th scope="col">Сейчас</th>
            </tr>
          </thead>
          <tbody>
            {card.attributes.map((attribute) => {
              const value = stored(attribute.id);
              const error = errors.get(attribute.id);
              return (
                <tr key={attribute.id}>
                  <td>
                    <div className="cell-stack">
                      <span className="ac-text-body-strong">
                        {ruText(attribute.names)}
                        {attribute.isRequiredForComplete ? " *" : ""}
                      </span>
                      {numberHint(attribute) && (
                        <span className="ac-text-caption ac-muted">{numberHint(attribute)}</span>
                      )}
                    </div>
                  </td>
                  <td className={error ? "fill-cell fill-cell--error" : "fill-cell"}>
                    <CellEditor
                      attribute={attribute}
                      raw={drafts.get(attribute.id) ?? valueInput(value)}
                      label={ruText(attribute.names)}
                      disabled={!online}
                      invalid={error !== undefined}
                      onChange={(raw) => setDrafts(new Map(drafts).set(attribute.id, raw))}
                    />
                    {error && (
                      <span className="fill-cell__error ac-text-caption" role="alert">
                        {error}
                      </span>
                    )}
                  </td>
                  <td className="ac-text-body-s">
                    {value === null ? (
                      <span className={missing.has(attribute.id) ? "warning-text" : "ac-muted"}>
                        {missing.has(attribute.id) ? "пусто — позиция неполная" : "пусто"}
                      </span>
                    ) : (
                      valueText(attribute, value)
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="ac-text-caption ac-muted">* — участвует в полноте.</p>
      {banner && (
        <Banner
          tone="warning"
          action={
            banner.conflict ? (
              <Button
                variant="text"
                size="s"
                onClick={() => {
                  setBanner(null);
                  onReload();
                }}
              >
                Обновить
              </Button>
            ) : undefined
          }
        >
          {banner.text}
        </Banner>
      )}
      <div className="button-row">
        <Button disabled={!online || drafts.size === 0} onClick={save}>
          Сохранить
        </Button>
        {drafts.size > 0 && (
          <Button
            variant="text"
            onClick={() => {
              setDrafts(new Map());
              setErrors(new Map());
            }}
          >
            Отменить правки
          </Button>
        )}
      </div>
    </div>
  );
}
