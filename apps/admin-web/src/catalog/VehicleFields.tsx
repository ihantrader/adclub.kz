import type {
  AdminVehicleEngine,
  AdminVehicleGeneration,
  AdminVehicleMake,
  AdminVehicleModel,
  AdminVehicleOption,
  CompatibilityConditions,
  CompatibilityConditionsInput,
  CompatibilityConditionsLabel,
  CompatibilityVehicle,
} from "@adclub/contracts";
import { TextField } from "@adclub/ui";
import { useEffect, useState } from "react";
import { apiClient } from "../api";

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

interface Book {
  makes: AdminVehicleMake[];
  engines: AdminVehicleEngine[];
  options: AdminVehicleOption[];
}

/** The vehicle catalog the selects choose from: active entries (archived ones stay in old records). */
function useBook(): Book | null {
  const [book, setBook] = useState<Book | null>(null);
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiClient.listVehicleMakes({ query: { status: "active", limit: 100 } }),
      apiClient.listVehicleEngines({ query: { status: "active", limit: 100 } }),
      apiClient.listVehicleOptions({ query: { status: "active" } }),
    ]).then(
      ([makes, engines, options]) =>
        !cancelled &&
        setBook({ makes: makes.makes, engines: engines.engines, options: options.options }),
      () => !cancelled && setBook({ makes: [], engines: [], options: [] }),
    );
    return () => {
      cancelled = true;
    };
  }, []);
  return book;
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
  const book = useBook();
  // Each list belongs to the level above it; a list of another make or model isn't shown.
  const [modelsOf, setModelsOf] = useState<{ makeId: string; models: AdminVehicleModel[] }>({
    makeId: "",
    models: [],
  });
  const [generationsOf, setGenerationsOf] = useState<{
    modelId: string;
    generations: AdminVehicleGeneration[];
  }>({ modelId: "", generations: [] });
  const models = modelsOf.makeId === value.makeId ? modelsOf.models : [];
  const generations = generationsOf.modelId === value.modelId ? generationsOf.generations : [];

  useEffect(() => {
    const makeId = value.makeId;
    if (!makeId) return;
    let cancelled = false;
    apiClient.listVehicleModels({ query: { makeId, status: "active", limit: 100 } }).then(
      (page) => !cancelled && setModelsOf({ makeId, models: page.models }),
      () => !cancelled && setModelsOf({ makeId, models: [] }),
    );
    return () => {
      cancelled = true;
    };
  }, [value.makeId]);

  useEffect(() => {
    const modelId = value.modelId;
    if (!modelId) return;
    let cancelled = false;
    apiClient.listVehicleGenerations({ query: { modelId, status: "active", limit: 100 } }).then(
      (page) => !cancelled && setGenerationsOf({ modelId, generations: page.generations }),
      () => !cancelled && setGenerationsOf({ modelId, generations: [] }),
    );
    return () => {
      cancelled = true;
    };
  }, [value.modelId]);

  const anyText = mode === "conditions" ? "Любой" : "Не знаю";
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
          {name === "makeId" ? (
            <option value="">Выберите марку</option>
          ) : (
            <option value="">{anyText}</option>
          )}
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
  const options = (kind: AdminVehicleOption["kind"]) =>
    (book?.options ?? [])
      .filter((option) => option.kind === kind)
      .map((option) => ({ id: option.id, text: option.names.ru }));

  return (
    <div className="vehicle-fields">
      {field(
        "makeId",
        "Марка",
        value.makeId,
        (book?.makes ?? []).map((make) => ({ id: make.id, text: make.name })),
        (makeId) => ({ makeId, modelId: "", generationId: "" }),
        labels?.make,
      )}
      {field(
        "modelId",
        "Модель",
        value.modelId,
        models.map((model) => ({ id: model.id, text: model.name })),
        (modelId) => ({ modelId, generationId: "" }),
        labels?.model,
      )}
      {field(
        "generationId",
        "Поколение",
        value.generationId,
        generations.map((generation) => ({
          id: generation.id,
          text: `${generation.name} (${generation.yearFrom}–${generation.yearTo ?? "н.в."})`,
        })),
        (generationId) => ({ generationId }),
        labels?.generation,
      )}
      {field(
        "bodyTypeId",
        "Кузов",
        value.bodyTypeId,
        options("body"),
        (bodyTypeId) => ({ bodyTypeId }),
        labels?.body,
      )}
      {field(
        "engineId",
        "Двигатель",
        value.engineId,
        (book?.engines ?? []).map((engine) => ({
          id: engine.id,
          text: [
            engine.code,
            engine.displacementL ? `${String(engine.displacementL).replace(".", ",")} л` : null,
            engine.powerHp ? `${engine.powerHp} л.с.` : null,
          ]
            .filter(Boolean)
            .join(" · "),
        })),
        (engineId) => ({ engineId }),
        labels?.engine,
      )}
      {field(
        "transmissionTypeId",
        "КПП",
        value.transmissionTypeId,
        options("transmission"),
        (transmissionTypeId) => ({ transmissionTypeId }),
        labels?.transmission,
      )}
      {field(
        "driveTypeId",
        "Привод",
        value.driveTypeId,
        options("drive"),
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
