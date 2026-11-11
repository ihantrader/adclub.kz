import type { AdminAttribute, ShowcaseAttributeFilter } from "@adclub/contracts";
import { Chip, ChipRow, Select, TextField } from "@adclub/ui";
import { useState } from "react";
import { conditionNumberOf, conditionText } from "./maintenance-words";

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

type Bounds = { min?: number; max?: number };

/**
 * «от / до» of a number (TASK-061.A): each field keeps the text as typed —
 * «4,», «-» are numbers half-typed — and it is read when the field is left
 * or Enter is pressed (saving leaves the field first). Not a number — the
 * field says so and the bound is not set.
 */
function NumberCondition({
  label,
  min,
  max,
  onChange,
}: {
  label: string;
  min: number | undefined;
  max: number | undefined;
  onChange: (bounds: Bounds | null) => void;
}) {
  const [texts, setTexts] = useState({ min: conditionText(min), max: conditionText(max) });
  const [bad, setBad] = useState({ min: false, max: false });
  // A bound changed from outside (another subcategory, a reset): the field follows it.
  const [seen, setSeen] = useState({ min, max });
  if (seen.min !== min || seen.max !== max) {
    setSeen({ min, max });
    setTexts({
      min: conditionNumberOf(texts.min) === (min ?? null) ? texts.min : conditionText(min),
      max: conditionNumberOf(texts.max) === (max ?? null) ? texts.max : conditionText(max),
    });
  }
  const commit = (side: "min" | "max") => {
    const value = conditionNumberOf(texts[side]);
    setBad((now) => ({ ...now, [side]: value === undefined }));
    const bounds: Bounds = {
      ...(min === undefined ? {} : { min }),
      ...(max === undefined ? {} : { max }),
    };
    if (value === null || value === undefined) delete bounds[side];
    else bounds[side] = value;
    onChange(bounds.min === undefined && bounds.max === undefined ? null : bounds);
  };
  const field = (side: "min" | "max", text: string) => (
    <TextField
      label={text}
      value={texts[side]}
      inputMode="decimal"
      placeholder="Любое"
      error={bad[side] ? "Не число — условие не задано" : undefined}
      onChange={(next) => setTexts((now) => ({ ...now, [side]: next }))}
      onBlur={() => commit(side)}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit(side);
      }}
    />
  );
  return (
    <div className="row-actions">
      {field("min", `${label}: от`)}
      {field("max", "до")}
    </div>
  );
}

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
          return (
            <NumberCondition
              key={attribute.id}
              label={unit ? `${name}, ${unit}` : name}
              min={current?.min}
              max={current?.max}
              onChange={(bounds) => set(bounds)}
            />
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
