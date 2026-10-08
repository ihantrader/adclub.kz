import type {
  AdminVehicleEngine,
  AdminVehicleGeneration,
  AdminVehicleMake,
  AdminVehicleModel,
  AdminVehicleModification,
  AdminVehicleOption,
  UpdateVehicleEngineBody,
  UpdateVehicleGenerationBody,
  UpdateVehicleModelBody,
  UpdateVehicleModificationBody,
  VehicleOptionKind,
  VehicleParentRef,
} from "@adclub/contracts";
import { auditEntities } from "@adclub/contracts";
import { Button, Dialog, TextField } from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useState, type ReactNode } from "react";
import { apiClient } from "../api";
import { SearchSelect } from "../search-select/SearchSelect";
import { SEARCH_PAGE, type Choice } from "../search-select/search-select-core";
import { createChoiceSources, engineChoice } from "../search-select/sources";
import { aliasesOf, FormError, numberOf, sameAliases, useSaver, type Saver } from "./shared";
import { OPTION_KIND_TEXT, yearsText } from "./vehicle-words";
import {
  FIRST_LISTED_YEAR,
  modificationYearChoices,
  yearChoices,
  yearFromValue,
  yearValue,
} from "./year-choices";

const sources = createChoiceSources(apiClient);

/** What a dialog edits: a record, a new one, or nothing (closed). */
type Editing<T> = T | "new" | null;

/** The frame of an edit dialog: «Сохранить» with the saver's state. */
function EditDialog({
  open,
  title,
  onClose,
  onSave,
  saver,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  onSave: () => void;
  saver: Saver;
  children: ReactNode;
}) {
  const online = useOnline();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      actions={
        <>
          <Button onClick={onSave} loading={saver.saving} disabled={!online}>
            Сохранить
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Отмена
          </Button>
        </>
      }
    >
      <div className="dialog-stack">{children}</div>
    </Dialog>
  );
}

/** Resets a dialog's form whenever another record is opened in it. */
function useOpened<T>(record: Editing<T>, reset: (record: Editing<T>) => void) {
  const [shown, setShown] = useState<Editing<T>>(null);
  if (record !== shown) {
    setShown(record);
    reset(record);
  }
}

/**
 * A year chosen from a list (TASK-035.C, D-071): the years of
 * `yearChoices`, newest first; the first entry — `none` («Выберите год»,
 * «по настоящее время»).
 */
function YearSelect({
  label,
  value,
  onChange,
  years,
  none,
  hint,
  error,
}: {
  label: string;
  value: number | null;
  onChange: (year: number | null) => void;
  years: readonly number[];
  none: string;
  hint?: string;
  error?: ReactNode;
}) {
  return (
    <label className="select">
      <span className="ac-text-caption ac-muted">{label}</span>
      <select
        value={yearValue(value)}
        aria-invalid={error ? true : undefined}
        onChange={(event) => onChange(yearFromValue(event.target.value))}
      >
        <option value="">{none}</option>
        {years.map((year) => (
          <option key={year} value={year}>
            {year}
          </option>
        ))}
      </select>
      {error ? (
        <span className="dialog-error">{error}</span>
      ) : hint ? (
        <span className="ac-text-caption ac-muted">{hint}</span>
      ) : null}
    </label>
  );
}

// -------------------------------------------------------------------- make

export function MakeDialog({
  make,
  onClose,
  onSaved,
  onRefresh,
}: {
  make: Editing<AdminVehicleMake>;
  onClose: () => void;
  onSaved: (make: AdminVehicleMake) => void;
  onRefresh?: () => void;
}) {
  const saver = useSaver(auditEntities.vehicleMake);
  const [name, setName] = useState("");
  const [aliases, setAliases] = useState("");
  const [local, setLocal] = useState<string | null>(null);
  useOpened(make, (opened) => {
    saver.reset();
    setLocal(null);
    setName(opened && opened !== "new" ? opened.name : "");
    setAliases(opened && opened !== "new" ? opened.aliases.join(", ") : "");
  });

  const save = async () => {
    if (!make) return;
    if (!name.trim()) {
      setLocal("Название обязательно");
      return;
    }
    setLocal(null);
    let saved: AdminVehicleMake | null = null;
    await saver.run(make === "new" ? null : make.id, async () => {
      if (make === "new") {
        saved = (
          await apiClient.createVehicleMake({ name: name.trim(), aliases: aliasesOf(aliases) })
        ).make;
        return;
      }
      const body: { expectedVersion: number; name?: string; aliases?: string[] } = {
        expectedVersion: saver.versionOf(make.version),
      };
      if (name.trim() !== make.name) body.name = name.trim();
      if (!sameAliases(aliasesOf(aliases), make.aliases)) body.aliases = aliasesOf(aliases);
      saved = (await apiClient.updateVehicleMake({ makeId: make.id }, body)).make;
    });
    if (saved) onSaved(saved);
  };

  return (
    <EditDialog
      open={make !== null}
      title={make === "new" ? "Новая марка" : "Изменить марку"}
      onClose={onClose}
      onSave={save}
      saver={saver}
    >
      <TextField
        label="Название"
        value={name}
        onChange={setName}
        autoComplete="off"
        error={local ?? saver.fieldError("name")}
      />
      <TextField
        label="Другие написания через запятую"
        value={aliases}
        onChange={setAliases}
        autoComplete="off"
        hint="Джили, GEELY Auto — по ним марку найдут в приложении и в файле импорта"
        error={saver.fieldError("aliases")}
      />
      <FormError saver={saver} fields={["name", "aliases"]} onRefresh={onRefresh} />
    </EditDialog>
  );
}

// ------------------------------------------------------------------- model

export function ModelDialog({
  model,
  make,
  onClose,
  onSaved,
  onRefresh,
}: {
  model: Editing<AdminVehicleModel>;
  /** The make a new model is added to (and the one a model is in now). */
  make: VehicleParentRef;
  onClose: () => void;
  onSaved: (model: AdminVehicleModel) => void;
  onRefresh?: () => void;
}) {
  const saver = useSaver(auditEntities.vehicleModel, {
    parents: { make: model && model !== "new" ? model.make : make },
  });
  const [name, setName] = useState("");
  const [aliases, setAliases] = useState("");
  const [owner, setOwner] = useState<Choice | null>(null);
  const [local, setLocal] = useState<string | null>(null);
  useOpened(model, (opened) => {
    saver.reset();
    setLocal(null);
    setName(opened && opened !== "new" ? opened.name : "");
    setAliases(opened && opened !== "new" ? opened.aliases.join(", ") : "");
    setOwner(
      opened && opened !== "new"
        ? { id: opened.make.id, label: opened.make.name, muted: opened.make.status === "archived" }
        : { id: make.id, label: make.name, muted: make.status === "archived" },
    );
  });

  const save = async () => {
    if (!model) return;
    if (!name.trim()) {
      setLocal("Название обязательно");
      return;
    }
    setLocal(null);
    let saved: AdminVehicleModel | null = null;
    await saver.run(model === "new" ? null : model.id, async () => {
      if (model === "new") {
        saved = (
          await apiClient.createVehicleModel({
            makeId: make.id,
            name: name.trim(),
            aliases: aliasesOf(aliases),
          })
        ).model;
        return;
      }
      const body: UpdateVehicleModelBody = { expectedVersion: saver.versionOf(model.version) };
      if (name.trim() !== model.name) body.name = name.trim();
      if (!sameAliases(aliasesOf(aliases), model.aliases)) body.aliases = aliasesOf(aliases);
      if (owner && owner.id !== model.make.id) body.makeId = owner.id;
      saved = (await apiClient.updateVehicleModel({ modelId: model.id }, body)).model;
    });
    if (saved) onSaved(saved);
  };

  return (
    <EditDialog
      open={model !== null}
      title={model === "new" ? `Новая модель марки ${make.name}` : "Изменить модель"}
      onClose={onClose}
      onSave={save}
      saver={saver}
    >
      <TextField
        label="Название"
        value={name}
        onChange={setName}
        autoComplete="off"
        error={local ?? saver.fieldError("name")}
      />
      <TextField
        label="Другие написания через запятую"
        value={aliases}
        onChange={setAliases}
        autoComplete="off"
        hint="Кулрей, Coolray Sport"
        error={saver.fieldError("aliases")}
      />
      {model !== "new" && (
        <SearchSelect
          label="Марка"
          value={owner}
          onChange={(choice) => choice && setOwner(choice)}
          search={sources.makes("active")}
          hint="Другая марка — модель переедет к ней вместе с поколениями и модификациями"
          error={saver.error?.field === "makeId" ? saver.error.text : null}
        />
      )}
      <FormError saver={saver} fields={["name", "aliases", "makeId"]} onRefresh={onRefresh} />
    </EditDialog>
  );
}

// -------------------------------------------------------------- generation

export function GenerationDialog({
  generation,
  model,
  onClose,
  onSaved,
  onRefresh,
}: {
  generation: Editing<AdminVehicleGeneration>;
  /** The model a new generation is added to, with its make. */
  model: VehicleParentRef & { make: VehicleParentRef };
  onClose: () => void;
  onSaved: (generation: AdminVehicleGeneration) => void;
  onRefresh?: () => void;
}) {
  const saver = useSaver(auditEntities.vehicleGeneration, {
    parents: { make: model.make, model },
  });
  const [name, setName] = useState("");
  const [yearFrom, setYearFrom] = useState<number | null>(null);
  const [yearTo, setYearTo] = useState<number | null>(null);
  const [local, setLocal] = useState<{ field: string; text: string } | null>(null);
  const record = generation && generation !== "new" ? generation : null;
  useOpened(generation, (opened) => {
    saver.reset();
    setLocal(null);
    setName(opened && opened !== "new" ? opened.name : "");
    setYearFrom(opened && opened !== "new" ? opened.yearFrom : null);
    setYearTo(opened && opened !== "new" ? opened.yearTo : null);
  });

  const save = async () => {
    if (!generation) return;
    if (!name.trim()) return setLocal({ field: "name", text: "Название обязательно" });
    if (yearFrom === null) return setLocal({ field: "yearFrom", text: "Выберите первый год" });
    setLocal(null);
    let saved: AdminVehicleGeneration | null = null;
    await saver.run(generation === "new" ? null : generation.id, async () => {
      if (generation === "new") {
        saved = (
          await apiClient.createVehicleGeneration({
            modelId: model.id,
            name: name.trim(),
            yearFrom,
            yearTo,
          })
        ).generation;
        return;
      }
      const body: UpdateVehicleGenerationBody = {
        expectedVersion: saver.versionOf(generation.version),
      };
      if (name.trim() !== generation.name) body.name = name.trim();
      if (yearFrom !== generation.yearFrom) body.yearFrom = yearFrom;
      if (yearTo !== generation.yearTo) body.yearTo = yearTo;
      saved = (await apiClient.updateVehicleGeneration({ generationId: generation.id }, body))
        .generation;
    });
    if (saved) onSaved(saved);
  };

  const error = (field: string) => (local?.field === field ? local.text : saver.fieldError(field));
  return (
    <EditDialog
      open={generation !== null}
      title={
        generation === "new"
          ? `Новое поколение ${model.make.name} ${model.name}`
          : "Изменить поколение"
      }
      onClose={onClose}
      onSave={save}
      saver={saver}
    >
      <TextField
        label="Название"
        value={name}
        onChange={setName}
        autoComplete="off"
        hint="I, II (FX11), рестайлинг"
        error={error("name")}
      />
      <div className="form-grid">
        <YearSelect
          label="Год с"
          value={yearFrom}
          onChange={setYearFrom}
          years={yearChoices({ keep: [record?.yearFrom] })}
          none="Выберите год"
          error={error("yearFrom")}
        />
        <YearSelect
          label="Год по"
          value={yearTo}
          onChange={setYearTo}
          // Not before «с»: a 1998 from a file lists from 1998.
          years={yearChoices({ from: yearFrom ?? FIRST_LISTED_YEAR, keep: [record?.yearTo] })}
          none="по настоящее время"
          error={error("yearTo")}
        />
      </div>
      <FormError saver={saver} fields={["name", "yearFrom", "yearTo"]} onRefresh={onRefresh} />
    </EditDialog>
  );
}

// ------------------------------------------------------------ modification

/** A select of one reference list: the active options, and the chosen one even if archived. */
function OptionSelect({
  label,
  kind,
  options,
  value,
  onChange,
  error,
  current,
}: {
  label: string;
  kind: VehicleOptionKind;
  options: readonly AdminVehicleOption[];
  value: string;
  onChange: (id: string) => void;
  error?: ReactNode;
  /** The record's own option, shown even when archived. */
  current?: { id: string; names: { ru: string }; status: "active" | "archived" } | null;
}) {
  const active = options.filter((option) => option.kind === kind && option.status === "active");
  const extra = current && !active.some((option) => option.id === current.id) ? current : null;
  return (
    <label className="select">
      <span className="ac-text-caption ac-muted">{label}</span>
      <select
        value={value}
        aria-invalid={error ? true : undefined}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Выберите</option>
        {extra && (
          <option value={extra.id}>
            {extra.names.ru}
            {extra.status === "archived" ? " (в архиве)" : ""}
          </option>
        )}
        {active.map((option) => (
          <option key={option.id} value={option.id}>
            {option.names.ru}
          </option>
        ))}
      </select>
      {error && <span className="dialog-error">{error}</span>}
    </label>
  );
}

/**
 * A modification (A-CAR-01). The market is the server's and the import
 * file's: the admin panel doesn't offer it (TASK-035.C, D-071) — a new
 * modification is `kz`, as before, and an edit never sends it. An engine
 * that isn't in the catalog yet is added right from «Двигатель»
 * («Новый двигатель «…»» of the search) and is chosen once saved; what is
 * typed in this form stays.
 */
export function ModificationDialog({
  modification,
  generation,
  options,
  onClose,
  onSaved,
  onRefresh,
}: {
  modification: Editing<AdminVehicleModification>;
  generation: AdminVehicleGeneration;
  /** The reference lists, every status. */
  options: readonly AdminVehicleOption[];
  onClose: () => void;
  onSaved: (modification: AdminVehicleModification) => void;
  onRefresh?: () => void;
}) {
  const saver = useSaver(auditEntities.vehicleModification, {
    parents: {
      make: generation.make,
      model: generation.model,
      generation: { id: generation.id, name: generation.name, status: generation.status },
    },
    generationId: generation.id,
  });
  const [body, setBody] = useState("");
  const [engine, setEngine] = useState<Choice | null>(null);
  const [transmission, setTransmission] = useState("");
  const [drive, setDrive] = useState("");
  const [yearFrom, setYearFrom] = useState<number | null>(null);
  const [yearTo, setYearTo] = useState<number | null>(null);
  /** The code typed for «Новый двигатель»: its form is open while not `null`. */
  const [newEngine, setNewEngine] = useState<string | null>(null);
  const [local, setLocal] = useState<{ field: string; text: string } | null>(null);
  useOpened(modification, (opened) => {
    saver.reset();
    setLocal(null);
    const record = opened && opened !== "new" ? opened : null;
    setBody(record?.bodyType.id ?? "");
    setEngine(
      record
        ? {
            id: record.engine.id,
            label: record.engine.code,
            note: record.engine.status === "archived" ? "в архиве" : null,
            muted: record.engine.status === "archived",
          }
        : null,
    );
    setTransmission(record?.transmissionType.id ?? "");
    setDrive(record?.driveType.id ?? "");
    setYearFrom(record ? record.yearFrom : generation.yearFrom);
    setYearTo(record ? record.yearTo : generation.yearTo);
    setNewEngine(null);
  });
  const record = modification && modification !== "new" ? modification : null;

  const save = async () => {
    if (!modification) return;
    const missing = !body
      ? "bodyTypeId"
      : !engine
        ? "engineId"
        : !transmission
          ? "transmissionTypeId"
          : !drive
            ? "driveTypeId"
            : null;
    if (missing) return setLocal({ field: missing, text: "Выберите значение" });
    if (yearFrom === null) return setLocal({ field: "yearFrom", text: "Выберите первый год" });
    if (yearTo === null && generation.yearTo !== null) {
      // The generation ended: a modification can't still be made.
      return setLocal({ field: "yearTo", text: "Выберите последний год" });
    }
    setLocal(null);
    let saved: AdminVehicleModification | null = null;
    await saver.run(record?.id ?? null, async () => {
      if (!record) {
        saved = (
          await apiClient.createVehicleModification({
            generationId: generation.id,
            bodyTypeId: body,
            engineId: engine!.id,
            transmissionTypeId: transmission,
            driveTypeId: drive,
            yearFrom,
            yearTo,
            // Not offered by the admin panel (D-071): the value it always had.
            market: "kz",
          })
        ).modification;
        return;
      }
      // Only what was changed: an archived engine or option kept as it is is never sent again.
      const patch: UpdateVehicleModificationBody = {
        expectedVersion: saver.versionOf(record.version),
      };
      if (body !== record.bodyType.id) patch.bodyTypeId = body;
      if (engine!.id !== record.engine.id) patch.engineId = engine!.id;
      if (transmission !== record.transmissionType.id) patch.transmissionTypeId = transmission;
      if (drive !== record.driveType.id) patch.driveTypeId = drive;
      if (yearFrom !== record.yearFrom) patch.yearFrom = yearFrom;
      if (yearTo !== record.yearTo) patch.yearTo = yearTo;
      saved = (await apiClient.updateVehicleModification({ modificationId: record.id }, patch))
        .modification;
    });
    if (saved) onSaved(saved);
  };

  const error = (field: string) => (local?.field === field ? local.text : saver.fieldError(field));
  return (
    <>
      <EditDialog
        open={modification !== null}
        title={record ? "Изменить модификацию" : "Новая модификация"}
        onClose={onClose}
        onSave={save}
        saver={saver}
      >
        <p className="ac-text-body-s ac-muted">
          {generation.make.name} {generation.model.name} · поколение {generation.name},{" "}
          {yearsText(generation.yearFrom, generation.yearTo)}
        </p>
        <div className="form-grid">
          <OptionSelect
            label="Кузов"
            kind="body"
            options={options}
            value={body}
            onChange={setBody}
            current={record?.bodyType}
            error={error("bodyTypeId")}
          />
          <SearchSelect
            label="Двигатель"
            name="engineId"
            value={engine}
            onChange={setEngine}
            search={sources.engines("active")}
            placeholder="Код двигателя"
            create={{ label: "Новый двигатель", onCreate: setNewEngine }}
            error={
              local?.field === "engineId"
                ? local.text
                : saver.error?.field === "engineId"
                  ? saver.error.text
                  : null
            }
          />
          <OptionSelect
            label="КПП"
            kind="transmission"
            options={options}
            value={transmission}
            onChange={setTransmission}
            current={record?.transmissionType}
            error={error("transmissionTypeId")}
          />
          <OptionSelect
            label="Привод"
            kind="drive"
            options={options}
            value={drive}
            onChange={setDrive}
            current={record?.driveType}
            error={error("driveTypeId")}
          />
          <YearSelect
            label="Год с"
            value={yearFrom}
            onChange={setYearFrom}
            years={modificationYearChoices(generation, [record?.yearFrom])}
            none="Выберите год"
            error={error("yearFrom")}
          />
          <YearSelect
            label="Год по"
            value={yearTo}
            onChange={setYearTo}
            years={modificationYearChoices(
              { yearFrom: yearFrom ?? generation.yearFrom, yearTo: generation.yearTo },
              [record?.yearTo],
            )}
            // Only a generation still made has modifications still made.
            none={generation.yearTo === null ? "по настоящее время" : "Выберите год"}
            error={error("yearTo")}
          />
        </div>
        <FormError
          saver={saver}
          fields={[
            "bodyTypeId",
            "engineId",
            "transmissionTypeId",
            "driveTypeId",
            "yearFrom",
            "yearTo",
          ]}
          onRefresh={onRefresh}
        />
      </EditDialog>
      {/* A sibling, not a child: the engine's dialog opens above, and closing it leaves this form as it was. */}
      <EngineDialog
        engine={newEngine === null ? null : "new"}
        initialCode={newEngine ?? ""}
        options={options}
        onClose={() => setNewEngine(null)}
        onSaved={(created) => {
          setEngine(engineChoice(created));
          setNewEngine(null);
          if (local?.field === "engineId") setLocal(null);
        }}
        onChooseExisting={(existing) => {
          setEngine(existing);
          setNewEngine(null);
          if (local?.field === "engineId") setLocal(null);
        }}
      />
    </>
  );
}

// ------------------------------------------------------------------ engine

export function EngineDialog({
  engine,
  initialCode = "",
  options,
  onClose,
  onSaved,
  onChooseExisting,
  onRefresh,
}: {
  engine: Editing<AdminVehicleEngine>;
  /** A new engine's code to start with: what was typed in the search (TASK-035.C). */
  initialCode?: string;
  options: readonly AdminVehicleOption[];
  onClose: () => void;
  onSaved: (engine: AdminVehicleEngine) => void;
  /**
   * Opened from a modification: an engine that already has this code (a
   * colleague added it a moment ago) is offered to choose instead of a
   * link away from the form.
   */
  onChooseExisting?: (engine: Choice) => void;
  onRefresh?: () => void;
}) {
  const saver = useSaver(auditEntities.vehicleEngine);
  const [code, setCode] = useState("");
  const [aliases, setAliases] = useState("");
  const [fuel, setFuel] = useState("");
  const [displacement, setDisplacement] = useState("");
  const [power, setPower] = useState("");
  const [local, setLocal] = useState<{ field: string; text: string } | null>(null);
  const [choosing, setChoosing] = useState(false);
  const record = engine && engine !== "new" ? engine : null;
  useOpened(engine, (opened) => {
    saver.reset();
    setLocal(null);
    setChoosing(false);
    const shown = opened && opened !== "new" ? opened : null;
    setCode(shown?.code ?? (opened === "new" ? initialCode.trim() : ""));
    setAliases(shown?.aliases.join(", ") ?? "");
    setFuel(shown?.fuel.id ?? "");
    setDisplacement(
      shown?.displacementL == null ? "" : String(shown.displacementL).replace(".", ","),
    );
    setPower(shown?.powerHp == null ? "" : String(shown.powerHp));
  });

  const save = async () => {
    if (!engine) return;
    const displacementL = numberOf(displacement);
    const powerHp = numberOf(power);
    if (!code.trim()) return setLocal({ field: "code", text: "Код обязателен" });
    if (!fuel) return setLocal({ field: "fuelId", text: "Выберите топливо" });
    if (Number.isNaN(displacementL)) {
      return setLocal({ field: "displacementL", text: "Объём — число литров, например 1,5" });
    }
    if (Number.isNaN(powerHp) || (powerHp !== null && !Number.isInteger(powerHp))) {
      return setLocal({ field: "powerHp", text: "Мощность — целое число л.с." });
    }
    setLocal(null);
    let saved: AdminVehicleEngine | null = null;
    await saver.run(record?.id ?? null, async () => {
      if (!record) {
        saved = (
          await apiClient.createVehicleEngine({
            code: code.trim(),
            aliases: aliasesOf(aliases),
            fuelId: fuel,
            displacementL,
            powerHp,
          })
        ).engine;
        return;
      }
      const body: UpdateVehicleEngineBody = { expectedVersion: saver.versionOf(record.version) };
      if (code.trim() !== record.code) body.code = code.trim();
      if (!sameAliases(aliasesOf(aliases), record.aliases)) body.aliases = aliasesOf(aliases);
      if (fuel !== record.fuel.id) body.fuelId = fuel;
      if (displacementL !== record.displacementL) body.displacementL = displacementL;
      if (powerHp !== record.powerHp) body.powerHp = powerHp;
      saved = (await apiClient.updateVehicleEngine({ engineId: record.id }, body)).engine;
    });
    if (saved) onSaved(saved);
  };

  // The engine the server named as taken, to choose instead (nested in a modification only).
  const existingId = onChooseExisting && !record ? (saver.error?.existingId ?? null) : null;
  const chooseExisting = async () => {
    if (!existingId || !onChooseExisting) return;
    setChoosing(true);
    try {
      const page = await apiClient.listVehicleEngines({
        query: { q: code.trim(), limit: SEARCH_PAGE },
      });
      const found = page.engines.find((entry) => entry.id === existingId);
      onChooseExisting(found ? engineChoice(found) : { id: existingId, label: code.trim() });
    } catch {
      // The search failed: the id is enough to choose it, the code is what was typed.
      onChooseExisting({ id: existingId, label: code.trim() });
    } finally {
      setChoosing(false);
    }
  };

  const error = (field: string) =>
    local?.field === field
      ? local.text
      : existingId && field === "code" && saver.error?.field === "code"
        ? saver.error.text
        : saver.fieldError(field);
  return (
    <EditDialog
      open={engine !== null}
      title={record ? "Изменить двигатель" : "Новый двигатель"}
      onClose={onClose}
      onSave={save}
      saver={saver}
    >
      <TextField
        label="Код"
        value={code}
        onChange={setCode}
        autoComplete="off"
        hint="JLH-3G15TD — как в документах производителя"
        error={error("code")}
      />
      {existingId && (
        <div className="button-row">
          <Button variant="secondary" size="s" onClick={chooseExisting} loading={choosing}>
            Выбрать существующий
          </Button>
        </div>
      )}
      <TextField
        label="Другие написания через запятую"
        value={aliases}
        onChange={setAliases}
        autoComplete="off"
        hint="3G15TD"
        error={error("aliases")}
      />
      <div className="form-grid">
        <OptionSelect
          label="Топливо"
          kind="fuel"
          options={options}
          value={fuel}
          onChange={setFuel}
          current={record?.fuel}
          error={error("fuelId")}
        />
        <TextField
          label="Объём, л"
          value={displacement}
          onChange={setDisplacement}
          inputMode="decimal"
          autoComplete="off"
          hint="Пусто — электромотор или неизвестно"
          error={error("displacementL")}
        />
        <TextField
          label="Мощность, л.с."
          value={power}
          onChange={setPower}
          inputMode="numeric"
          autoComplete="off"
          error={error("powerHp")}
        />
      </div>
      {record && record.modificationCount > 0 && (
        <p className="ac-text-caption ac-muted">
          Двигатель выбран в модификациях: {record.modificationCount}. Изменение видно у всех.
        </p>
      )}
      <FormError
        saver={saver}
        fields={["code", "aliases", "fuelId", "displacementL", "powerHp"]}
        onRefresh={onRefresh}
      />
    </EditDialog>
  );
}

// ------------------------------------------------------------------ option

export function OptionDialog({
  option,
  kind,
  onClose,
  onSaved,
  onRefresh,
}: {
  option: Editing<AdminVehicleOption>;
  kind: VehicleOptionKind;
  onClose: () => void;
  onSaved: (option: AdminVehicleOption) => void;
  onRefresh?: () => void;
}) {
  const saver = useSaver(auditEntities.vehicleOption, { kind });
  const [code, setCode] = useState("");
  const [ru, setRu] = useState("");
  const [kk, setKk] = useState("");
  const [en, setEn] = useState("");
  const [local, setLocal] = useState<{ field: string; text: string } | null>(null);
  const record = option && option !== "new" ? option : null;
  useOpened(option, (opened) => {
    saver.reset();
    setLocal(null);
    const shown = opened && opened !== "new" ? opened : null;
    setCode("");
    setRu(shown?.names.ru ?? "");
    setKk(shown?.names.kk ?? "");
    setEn(shown?.names.en ?? "");
  });

  const save = async () => {
    if (!option) return;
    if (!record && !/^[a-z0-9][a-z0-9_]{0,62}$/.test(code.trim())) {
      return setLocal({
        field: "code",
        text: "Код — латинские строчные буквы, цифры и «_», например pickup",
      });
    }
    if (!ru.trim()) return setLocal({ field: "ru", text: "Русское название обязательно" });
    setLocal(null);
    const optional = (value: string) => (value.trim() ? value.trim() : null);
    let saved: AdminVehicleOption | null = null;
    await saver.run(record?.id ?? null, async () => {
      if (!record) {
        saved = (
          await apiClient.createVehicleOption({
            kind,
            code: code.trim(),
            names: { ru: ru.trim(), kk: optional(kk), en: optional(en) },
          })
        ).option;
        return;
      }
      const names: { ru?: string; kk?: string | null; en?: string | null } = {};
      if (ru.trim() !== record.names.ru) names.ru = ru.trim();
      if (optional(kk) !== record.names.kk) names.kk = optional(kk);
      if (optional(en) !== record.names.en) names.en = optional(en);
      saved = (
        await apiClient.updateVehicleOption(
          { optionId: record.id },
          { expectedVersion: saver.versionOf(record.version), names },
        )
      ).option;
    });
    if (saved) onSaved(saved);
  };

  const error = (field: string) =>
    local?.field === field
      ? local.text
      : saver.error?.field === "names" && field === "ru"
        ? saver.fieldError("names")
        : saver.fieldError(field);
  return (
    <EditDialog
      open={option !== null}
      title={`${record ? "Изменить" : "Новое значение"}: ${OPTION_KIND_TEXT[kind].toLowerCase()}`}
      onClose={onClose}
      onSave={save}
      saver={saver}
    >
      {record ? (
        <p className="ac-text-body-s ac-muted">
          Код <code>{record.code}</code> не меняется — по нему значение узнаёт файл импорта.
        </p>
      ) : (
        <TextField
          label="Код"
          value={code}
          onChange={setCode}
          autoComplete="off"
          hint="Латиницей, не меняется: pickup"
          error={error("code")}
        />
      )}
      <TextField
        label="Русский"
        value={ru}
        onChange={setRu}
        autoComplete="off"
        error={error("ru")}
      />
      <TextField
        label="Казахский"
        value={kk}
        onChange={setKk}
        autoComplete="off"
        hint="Вводится вручную: эти списки не переводятся автоматически"
        error={error("kk")}
      />
      <TextField
        label="Английский"
        value={en}
        onChange={setEn}
        autoComplete="off"
        error={error("en")}
      />
      <FormError saver={saver} fields={["code", "names", "ru", "kk", "en"]} onRefresh={onRefresh} />
    </EditDialog>
  );
}
