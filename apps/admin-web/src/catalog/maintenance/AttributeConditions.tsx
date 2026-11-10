import type { AdminAttribute, ShowcaseAttributeFilter } from "@adclub/contracts";
import { Chip, ChipRow, Select, TextField } from "@adclub/ui";

/**
 * The conditions of a rule on the characteristics of its subcategory
 * (TASK-061): exactly the filters of the client list (M-CAT-03, the
 * `attributes` of `GET /catalog/categories/{id}/items`) — a list by its
 * variants (any of them), a number from/to, yes/no — over the active
 * filterable characteristics only, so a rule is what a person could set in
 * the app's «Фильтры». Pure editing: the server checks it.
 */

export function usableAttributes(attributes: readonly AdminAttribute[]): AdminAttribute[] {
  return attributes.filter(
    (attribute) =>
      attribute.status === "active" && attribute.isFilterable && attribute.valueType !== "text",
  );
}

const numberOrUndefined = (text: string): number | undefined => {
  const value = Number(text.replace(",", ".").replace(/\s/gu, ""));
  return text.trim() === "" || !Number.isFinite(value) ? undefined : value;
};

/** The filter of one characteristic after a change; `null` — no condition on it. */
export function withCondition(
  filters: readonly ShowcaseAttributeFilter[],
  attributeId: string,
  next: Omit<ShowcaseAttributeFilter, "attributeId"> | null,
): ShowcaseAttributeFilter[] {
  const rest = filters.filter((filter) => filter.attributeId !== attributeId);
  const empty =
    next === null ||
    ((next.optionIds === undefined || next.optionIds.length === 0) &&
      next.min === undefined &&
      next.max === undefined &&
      next.value === undefined);
  return empty ? rest : [...rest, { attributeId, ...next }];
}

export function AttributeConditions({
  attributes,
  value,
  onChange,
}: {
  attributes: readonly AdminAttribute[];
  value: readonly ShowcaseAttributeFilter[];
  onChange: (value: ShowcaseAttributeFilter[]) => void;
}) {
  const usable = usableAttributes(attributes);
  if (usable.length === 0) {
    return (
      <p className="ac-text-body-s ac-muted">
        У подкатегории нет характеристик для фильтров — правило возьмёт все её позиции.
      </p>
    );
  }
  return (
    <div className="dialog-stack">
      {usable.map((attribute) => {
        const current = value.find((filter) => filter.attributeId === attribute.id);
        const name = attribute.names.ru?.text ?? attribute.code;
        const set = (next: Omit<ShowcaseAttributeFilter, "attributeId"> | null) =>
          onChange(withCondition(value, attribute.id, next));
        if (attribute.valueType === "enum") {
          const chosen = new Set(current?.optionIds ?? []);
          return (
            <ChipRow key={attribute.id} label={name}>
              <span className="ac-text-body-s">{name}:</span>
              {attribute.options
                .filter((option) => option.status === "active")
                .map((option) => (
                  <Chip
                    key={option.id}
                    selected={chosen.has(option.id)}
                    onClick={() => {
                      const next = new Set(chosen);
                      if (next.has(option.id)) next.delete(option.id);
                      else next.add(option.id);
                      set(next.size === 0 ? null : { optionIds: [...next] });
                    }}
                  >
                    {option.names.ru?.text ?? option.code}
                  </Chip>
                ))}
            </ChipRow>
          );
        }
        if (attribute.valueType === "number") {
          const unit = attribute.unit?.ru?.text;
          const label = unit ? `${name}, ${unit}` : name;
          return (
            <div key={attribute.id} className="row-actions">
              <TextField
                label={`${label}: от`}
                value={current?.min?.toString() ?? ""}
                inputMode="decimal"
                placeholder="Любое"
                onChange={(text) => {
                  const min = numberOrUndefined(text);
                  set({
                    ...(min === undefined ? {} : { min }),
                    ...(current?.max === undefined ? {} : { max: current.max }),
                  });
                }}
              />
              <TextField
                label="до"
                value={current?.max?.toString() ?? ""}
                inputMode="decimal"
                placeholder="Любое"
                onChange={(text) => {
                  const max = numberOrUndefined(text);
                  set({
                    ...(current?.min === undefined ? {} : { min: current.min }),
                    ...(max === undefined ? {} : { max }),
                  });
                }}
              />
            </div>
          );
        }
        return (
          <Select<"any" | "yes" | "no">
            key={attribute.id}
            label={name}
            value={current?.value === undefined ? "any" : current.value ? "yes" : "no"}
            options={[
              { value: "any", label: "Любое" },
              { value: "yes", label: "Да" },
              { value: "no", label: "Нет" },
            ]}
            onChange={(next) => set(next === "any" ? null : { value: next === "yes" })}
          />
        );
      })}
    </div>
  );
}
