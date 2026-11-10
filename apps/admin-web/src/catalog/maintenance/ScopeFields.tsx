import type { MaintenanceScopeInput } from "@adclub/contracts";
import { useMemo, useState } from "react";
import { apiClient } from "../../api";
import { SearchSelect } from "../../search-select/SearchSelect";
import type { Choice } from "../../search-select/search-select-core";
import { createChoiceSources } from "../../search-select/sources";

const sources = createChoiceSources(apiClient);

/** The levels of a plan's area as the fields hold them ("" — any). */
export interface ScopeChoice {
  makeId: string;
  modelId: string;
  generationId: string;
  engineId: string;
}

export const EMPTY_SCOPE: ScopeChoice = { makeId: "", modelId: "", generationId: "", engineId: "" };

export function scopeInputOf(choice: ScopeChoice): MaintenanceScopeInput {
  return {
    makeId: choice.makeId,
    modelId: choice.modelId || null,
    generationId: choice.generationId || null,
    engineId: choice.engineId || null,
  };
}

type Level = keyof ScopeChoice;

/**
 * The area of a plan (TASK-061): a make (required), and if wished a model,
 * a generation of it, an engine — each chosen with the search of the
 * vehicle catalog, as in «Совместимость» of an item. A level below is
 * cleared when the one above changes; the server checks that they agree.
 */
export function ScopeFields({
  value,
  onChange,
  errorField,
  errorText,
  compact,
}: {
  value: ScopeChoice;
  onChange: (value: ScopeChoice, labels: Partial<Record<Level, string>>) => void;
  errorField?: string | null;
  errorText?: string | null;
  compact?: boolean;
}) {
  const [chosen, setChosen] = useState<Partial<Record<Level, Choice>>>({});
  const makeSearch = useMemo(() => sources.makes("active"), []);
  const modelSearch = useMemo(() => sources.models(value.makeId, "active"), [value.makeId]);
  const generationSearch = useMemo(
    () => sources.generations(value.modelId, "active"),
    [value.modelId],
  );
  const engineSearch = useMemo(() => sources.engines("active"), []);
  const shown = (level: Level): Choice | null => {
    const id = value[level];
    if (!id) return null;
    const known = chosen[level];
    return known && known.id === id ? known : { id, label: "выбрано" };
  };
  const pick = (level: Level, choice: Choice | null, below: Level[]) => {
    const next = { ...chosen, [level]: choice ?? undefined };
    const changed = (choice?.id ?? "") !== value[level];
    const cleared = changed ? Object.fromEntries(below.map((name) => [name, ""])) : {};
    for (const name of changed ? below : []) delete next[name];
    setChosen(next);
    onChange(
      { ...value, [level]: choice?.id ?? "", ...cleared },
      Object.fromEntries(
        (Object.entries(next) as [Level, Choice | undefined][])
          .filter((entry): entry is [Level, Choice] => entry[1] !== undefined)
          .map(([name, entry]) => [name, entry.label]),
      ),
    );
  };
  const error = (level: Level) => (errorField === level ? errorText : null);
  return (
    <div className="vehicle-fields">
      <SearchSelect
        compact={compact}
        label="Марка"
        name="makeId"
        value={shown("makeId")}
        onChange={(choice) => pick("makeId", choice, ["modelId", "generationId"])}
        search={makeSearch}
        sourceKey="makes"
        placeholder="Найдите марку"
        error={error("makeId")}
      />
      <SearchSelect
        compact={compact}
        label="Модель"
        name="modelId"
        value={shown("modelId")}
        onChange={(choice) => pick("modelId", choice, ["generationId"])}
        search={modelSearch}
        sourceKey={value.makeId}
        empty="Любая"
        disabled={!value.makeId}
        hint={!value.makeId ? "Сначала выберите марку" : undefined}
        error={error("modelId")}
      />
      <SearchSelect
        compact={compact}
        label="Поколение"
        name="generationId"
        value={shown("generationId")}
        onChange={(choice) => pick("generationId", choice, [])}
        search={generationSearch}
        sourceKey={value.modelId}
        empty="Любое"
        disabled={!value.modelId}
        hint={!value.modelId ? "Сначала выберите модель" : undefined}
        error={error("generationId")}
      />
      <SearchSelect
        compact={compact}
        label="Двигатель"
        name="engineId"
        value={shown("engineId")}
        onChange={(choice) => pick("engineId", choice, [])}
        search={engineSearch}
        sourceKey="engines"
        empty="Любой"
        placeholder="Код двигателя"
        error={error("engineId")}
      />
    </div>
  );
}
