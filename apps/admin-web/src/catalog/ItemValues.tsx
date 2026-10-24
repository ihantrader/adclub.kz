import { isApiError } from "@adclub/api-client";
import {
  catalogValuesRejectedDetailsSchema,
  type AdminCatalogItemCard,
  type AttributeValue,
  type ItemValueInput,
} from "@adclub/contracts";
import { Badge, Banner, Button, EmptyState, TypeMark, useToast } from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useState } from "react";
import { apiClient } from "../api";
import { AppLink, Table } from "../layout/layout";
import { routePaths, withQuery } from "../router";
import { catalogErrorText, conflictText, isConflict } from "./catalog-words";
import { CellEditor, SaveBar } from "./Fill";
import { rejectionText } from "./fill-state";
import { whoChanged } from "./shared";
import { numberHint, parseValue, ruText, sameValue, valueInput, valueText } from "./values";

const COLUMNS = [
  { key: "attribute", header: "Характеристика" },
  { key: "value", header: "Значение", width: 360 },
];

/**
 * «Характеристики» of the card (A-CAT-05; TASK-080): every active
 * characteristic of the subcategory, an editor by type in its row (an empty
 * one «Не заполнено»), those that count for completeness marked; a changed
 * row shows «было: …» under it, and the edits wait in a panel at the bottom
 * («Есть изменения · Сохранить»). Saved together with the item's version,
 * refusals at their characteristic.
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
  const [saving, setSaving] = useState(false);
  const stored = (attributeId: string): AttributeValue =>
    card.values.find((entry) => entry.attributeId === attributeId)?.value ?? null;
  const missing = new Set(card.missingAttributeIds);

  if (card.attributes.length === 0) {
    return (
      <div className="card">
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
      </div>
    );
  }

  /** Whether the row's text is another value than the stored one (an unparsable one counts). */
  const changed = (attributeId: string): boolean => {
    const raw = drafts.get(attributeId);
    const attribute = card.attributes.find((entry) => entry.id === attributeId);
    if (raw === undefined || !attribute) return false;
    const parsed = parseValue(attribute, raw);
    return "error" in parsed || !sameValue(parsed.value, stored(attributeId));
  };
  const changedCount = card.attributes.filter((attribute) => changed(attribute.id)).length;

  const discard = () => {
    setDrafts(new Map());
    setErrors(new Map());
    setBanner(null);
  };

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
    setSaving(true);
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
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="detail-stack">
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
                Обновить данные
              </Button>
            ) : undefined
          }
        >
          {banner.text}
        </Banner>
      )}
      <Table label="Характеристики позиции" columns={COLUMNS}>
        {card.attributes.map((attribute) => {
          const value = stored(attribute.id);
          const error = errors.get(attribute.id);
          const hint = numberHint(attribute);
          const isChanged = changed(attribute.id);
          return (
            <tr key={attribute.id} className={isChanged ? "cat-row--changed" : undefined}>
              <td>
                <div className="cell-stack">
                  <span className="ac-text-body-strong">{ruText(attribute.names)}</span>
                  <span className="badges">
                    {hint && <span className="ac-text-caption ac-muted">{hint}</span>}
                    {missing.has(attribute.id) ? (
                      <Badge tone="warning" icon="alertTriangle">
                        Не заполнено — позиция неполная
                      </Badge>
                    ) : (
                      attribute.isRequiredForComplete && (
                        <TypeMark icon="checklist">Участвует в полноте</TypeMark>
                      )
                    )}
                  </span>
                </div>
              </td>
              <td>
                <div className="cell-stack cat-value">
                  <CellEditor
                    attribute={attribute}
                    raw={drafts.get(attribute.id) ?? valueInput(value)}
                    label={ruText(attribute.names)}
                    disabled={!online}
                    error={error}
                    onChange={(raw) => setDrafts(new Map(drafts).set(attribute.id, raw))}
                  />
                  {isChanged && (
                    <span className="cat-was">
                      было: {value === null ? "не заполнено" : valueText(attribute, value)}
                    </span>
                  )}
                </div>
              </td>
            </tr>
          );
        })}
      </Table>
      {changedCount > 0 && (
        <SaveBar
          note="Есть изменения"
          saving={saving}
          disabled={!online}
          onSave={save}
          onDiscard={discard}
        />
      )}
    </div>
  );
}
