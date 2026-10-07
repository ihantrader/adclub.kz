import type {
  AdminVehicleOption,
  CompatibilityConditions,
  CompatibilityConditionsInput,
  CompatibilityConditionsLabel,
  CompatibilityVehicle,
} from "@adclub/contracts";
import { TextField } from "@adclub/ui";
import { useEffect, useMemo, useState } from "react";
import { apiClient } from "../api";
import { SearchSelect } from "../search-select/SearchSelect";
import type { Choice } from "../search-select/search-select-core";
import { createChoiceSources } from "../search-select/sources";

const sources = createChoiceSources(apiClient);

/** The levels chosen by searching the server (lists that can be long). */
type SearchedLevel = "makeId" | "modelId" | "generationId" | "engineId";

type ChoiceSourceOf = ReturnType<ReturnType<typeof createChoiceSources>["makes"]>;

/** The levels of a car being chosen, as the selects hold them ("" — any / unknown). */
export interface VehicleChoice {
  makeId: string;
  modelId: string;
  generationId: string;
  bodyTypeId: string;
  engineId: string;
  transmissionTypeId: string;
  driveTypeId: string;
  yearFrom: string;
  yearTo: string;
  year: string;
}

export const EMPTY_CHOICE: VehicleChoice = {
  makeId: "",
  modelId: "",
  generationId: "",
  bodyTypeId: "",
  engineId: "",
  transmissionTypeId: "",
  driveTypeId: "",
  yearFrom: "",
  yearTo: "",
  year: "",
};

export function choiceOf(conditions: CompatibilityConditions): VehicleChoice {
  return {
    makeId: conditions.makeId,
    modelId: conditions.modelId ?? "",
    generationId: conditions.generationId ?? "",
    bodyTypeId: conditions.bodyTypeId ?? "",
    engineId: conditions.engineId ?? "",
    transmissionTypeId: conditions.transmissionTypeId ?? "",
    driveTypeId: conditions.driveTypeId ?? "",
    yearFrom: conditions.yearFrom?.toString() ?? "",
    yearTo: conditions.yearTo?.toString() ?? "",
    year: "",
  };
}

const year = (text: string): number | null => {
  const value = Number(text.trim());
  return text.trim() && Number.isInteger(value) ? value : null;
};
const id = (text: string): string | null => (text ? text : null);

/** The conditions of a record (an empty level — any car). */
export function conditionsOf(choice: VehicleChoice): CompatibilityConditionsInput {
  return {
    makeId: choice.makeId,
    modelId: id(choice.modelId),
    generationId: id(choice.generationId),
    bodyTypeId: id(choice.bodyTypeId),
    engineId: id(choice.engineId),
    transmissionTypeId: id(choice.transmissionTypeId),
    driveTypeId: id(choice.driveTypeId),
    yearFrom: year(choice.yearFrom),
    yearTo: year(choice.yearTo),
  };
}

/** A car to check (an empty level — not known). */
export function vehicleOf(choice: VehicleChoice): CompatibilityVehicle {
  const car: CompatibilityVehicle = { makeId: choice.makeId };
  if (choice.modelId) car.modelId = choice.modelId;
  if (choice.generationId) car.generationId = choice.generationId;
  if (choice.bodyTypeId) car.bodyTypeId = choice.bodyTypeId;
  if (choice.engineId) car.engineId = choice.engineId;
  if (choice.transmissionTypeId) car.transmissionTypeId = choice.transmissionTypeId;
  if (choice.driveTypeId) car.driveTypeId = choice.driveTypeId;
  const asked = year(choice.year);
  if (asked !== null) car.year = asked;
  return car;
}

/** A record's conditions as one line. */
export function labelText(label: CompatibilityConditionsLabel): string {
  return [
    label.make,
    label.model,
    label.generation,
    label.body,
    label.engine,
    label.transmission,
    label.drive,
    label.years,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The reference lists the selects choose from: a few dozen options, loaded whole. */
function useOptions(): AdminVehicleOption[] {
  const [options, setOptions] = useState<AdminVehicleOption[]>([]);
  useEffect(() => {
    let cancelled = false;
    apiClient.listVehicleOptions({ query: { status: "active" } }).then(
      (answer) => !cancelled && setOptions(answer.options),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, []);
  return options;
}

/**
 * The levels of a car chosen from the vehicle catalog (TASK-035; SCREENS
 * A-CAT-05): a make, then optionally a model, a generation, the body, the
 * engine, the gearbox, the drive and the years of a record (`conditions`)
 * or the year of a car to check (`car`). The server checks that the levels
 * agree; here a lower level is cleared when the one above changes.
 */
export function VehicleFields({
  value,
  onChange,
  mode,
  labels,
  errorField,
  errorText,
}: {
  value: VehicleChoice;
  onChange: (value: VehicleChoice) => void;
  mode: "conditions" | "car";
  /** Names of the chosen levels when they are no longer among the active ones. */
  labels?: CompatibilityConditionsLabel;
  errorField?: string | null;
  errorText?: string | null;
}) {
  const options = useOptions();
  // The entries chosen here, by level: what the field shows (records name theirs in `labels`).
  const [chosen, setChosen] = useState<Partial<Record<SearchedLevel, Choice>>>({});
  const shown = (level: SearchedLevel, fallback?: string | null): Choice | null => {
    const id = value[level];
    if (!id) return null;
    const known = chosen[level];
    return known && known.id === id ? known : { id, label: fallback ?? "выбрано ранее" };
  };
  const pick = (level: SearchedLevel, choice: Choice | null, patch: Partial<VehicleChoice>) => {
    setChosen((now) => ({ ...now, [level]: choice ?? undefined }));
    // The levels below are cleared only when this one really changes.
    const changed = (choice?.id ?? "") !== value[level];
    onChange({ ...value, [level]: choice?.id ?? "", ...(changed ? patch : {}) });
  };
  const searched = (
    level: SearchedLevel,
    label: string,
    search: ChoiceSourceOf,
    sourceKey: string,
    patch: Partial<VehicleChoice>,
    fallback?: string | null,
    extra: { empty?: string; disabled?: boolean; placeholder?: string } = {},
  ) => (
    <SearchSelect
      key={level}
      label={label}
      name={level}
      value={shown(level, fallback)}
      onChange={(choice) => pick(level, choice, patch)}
      search={search}
      sourceKey={sourceKey}
      empty={extra.empty}
      disabled={extra.disabled}
      placeholder={extra.placeholder}
      error={errorField === level ? errorText : null}
    />
  );

  const anyText = mode === "conditions" ? "Любой" : "Не знаю";
  const makeSearch = useMemo(() => sources.makes("active"), []);
  const engineSearch = useMemo(() => sources.engines("active"), []);
  const modelSearch = useMemo(() => sources.models(value.makeId, "active"), [value.makeId]);
  const generationSearch = useMemo(
    () => sources.generations(value.modelId, "active"),
    [value.modelId],
  );
  const field = (
    name: string,
    label: string,
    current: string,
    entries: { id: string; text: string }[],
    patch: (v: string) => Partial<VehicleChoice>,
    fallback?: string | null,
  ) => {
    const known = entries.some((entry) => entry.id === current);
    return (
      <label className="select" key={name}>
        <span className="ac-text-caption ac-muted">{label}</span>
        <select
          value={current}
          aria-invalid={errorField === name || undefined}
          onChange={(event) => onChange({ ...value, ...patch(event.target.value) })}
        >
          <option value="">{anyText}</option>
          {current && !known && <option value={current}>{fallback ?? "выбрано ранее"}</option>}
          {entries.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.text}
            </option>
          ))}
        </select>
        {errorField === name && errorText && <span className="dialog-error">{errorText}</span>}
      </label>
    );
  };
  const optionsOf = (kind: AdminVehicleOption["kind"]) =>
    options
      .filter((option) => option.kind === kind)
      .map((option) => ({ id: option.id, text: option.names.ru }));

  return (
    <div className="vehicle-fields">
      {searched(
        "makeId",
        "Марка",
        makeSearch,
        "makes",
        { modelId: "", generationId: "" },
        labels?.make,
        { placeholder: "Найдите марку" },
      )}
      {searched(
        "modelId",
        "Модель",
        modelSearch,
        value.makeId,
        { generationId: "" },
        labels?.model,
        { empty: anyText, disabled: !value.makeId },
      )}
      {searched(
        "generationId",
        "Поколение",
        generationSearch,
        value.modelId,
        {},
        labels?.generation,
        { empty: anyText, disabled: !value.modelId },
      )}
      {field(
        "bodyTypeId",
        "Кузов",
        value.bodyTypeId,
        optionsOf("body"),
        (bodyTypeId) => ({ bodyTypeId }),
        labels?.body,
      )}
      {searched("engineId", "Двигатель", engineSearch, "engines", {}, labels?.engine, {
        empty: anyText,
        placeholder: "Код двигателя",
      })}
      {field(
        "transmissionTypeId",
        "КПП",
        value.transmissionTypeId,
        optionsOf("transmission"),
        (transmissionTypeId) => ({ transmissionTypeId }),
        labels?.transmission,
      )}
      {field(
        "driveTypeId",
        "Привод",
        value.driveTypeId,
        optionsOf("drive"),
        (driveTypeId) => ({ driveTypeId }),
        labels?.drive,
      )}
      {mode === "conditions" ? (
        <>
          <TextField
            label="Год с"
            value={value.yearFrom}
            onChange={(yearFrom) => onChange({ ...value, yearFrom })}
            inputMode="numeric"
            error={errorField === "yearFrom" ? (errorText ?? undefined) : undefined}
          />
          <TextField
            label="Год по"
            value={value.yearTo}
            onChange={(yearTo) => onChange({ ...value, yearTo })}
            inputMode="numeric"
            error={errorField === "yearTo" ? (errorText ?? undefined) : undefined}
          />
        </>
      ) : (
        <TextField
          label="Год выпуска"
          value={value.year}
          onChange={(year) => onChange({ ...value, year })}
          inputMode="numeric"
        />
      )}
    </div>
  );
}
