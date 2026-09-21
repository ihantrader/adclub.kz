import { createHash } from "node:crypto";
import {
  VEHICLE_IMPORT_CELL_MAX_LENGTH,
  VEHICLE_IMPORT_REPORT_REJECTED_MAX,
  VEHICLE_YEAR_MAX,
  VEHICLE_YEAR_MIN,
  vehicleImportColumns,
  vehicleImportRequiredColumns,
  type VehicleEntryStatus,
  type VehicleImportColumn,
  type VehicleImportPlan,
  type VehicleImportReason,
  type VehicleImportReasonCode,
  type VehicleImportReport,
  type VehicleMarket,
  type VehicleOptionKind,
} from "@adclub/contracts";
import { nameKey, normalizeText, spellingKey, withinYears } from "../vehicle-common";

/**
 * The check of an import row (TASK-014 requirement 3; ARCHITECTURE 4.24),
 * without the database: a row is planned against a snapshot of the
 * catalog, and a planned row is then committed into the snapshot — with
 * placeholder ids when the report is made, with the ids of the rows really
 * written when the import is applied. The same code decides both, so the
 * report and the application can't disagree about the rules; they differ
 * only in the catalog they look at.
 *
 * The import never changes an existing make, model, generation, engine or
 * option: it creates the makes, models, generations and engines a row
 * needs, and creates or updates (the market) modifications. Reference list
 * values (body, transmission, drive, fuel) are never created from a file.
 */

export type RowValues = Partial<Record<VehicleImportColumn, string>>;

interface Entry {
  id: string;
  status: VehicleEntryStatus;
}

export interface GenerationEntry extends Entry {
  yearFrom: number;
  yearTo: number | null;
  /** The row that creates it (placeholders only). */
  row?: number;
}

export interface EngineEntry extends Entry {
  fuelId: string;
  displacementL: number | null;
  powerHp: number | null;
}

export interface ModificationEntry extends Entry {
  market: VehicleMarket;
}

/** The catalog as a row is checked against. Placeholder ids start with `new:`. */
export interface ImportSnapshot {
  /** Options by kind, by code and by every name (case ignored). */
  options: Map<VehicleOptionKind, Map<string, Entry>>;
  /** Makes by spelling key. */
  makes: Map<string, Entry>;
  /** Models by `<makeId>|<spelling key>`. */
  models: Map<string, Entry>;
  /** Generations by `<modelId>|<name key>`. */
  generations: Map<string, GenerationEntry>;
  /** Engines by spelling key. */
  engines: Map<string, EngineEntry>;
  /** Modifications by their identity (`identityKey`). */
  modifications: Map<string, ModificationEntry>;
}

export function emptySnapshot(): ImportSnapshot {
  return {
    options: new Map([
      ["body", new Map()],
      ["transmission", new Map()],
      ["drive", new Map()],
      ["fuel", new Map()],
    ]),
    makes: new Map(),
    models: new Map(),
    generations: new Map(),
    engines: new Map(),
    modifications: new Map(),
  };
}

export function modelKey(makeId: string, name: string): string {
  return `${makeId}|${spellingKey(name)}`;
}

export function generationKey(modelId: string, name: string): string {
  return `${modelId}|${nameKey(name)}`;
}

export interface ModificationIdentity {
  generationId: string;
  bodyTypeId: string;
  engineId: string;
  transmissionTypeId: string;
  driveTypeId: string;
  yearFrom: number;
  yearTo: number | null;
}

export function identityKey(identity: ModificationIdentity): string {
  return [
    identity.generationId,
    identity.bodyTypeId,
    identity.engineId,
    identity.transmissionTypeId,
    identity.driveTypeId,
    identity.yearFrom,
    identity.yearTo ?? "",
  ].join("|");
}

/** The hash of a row's content: the same cells (case and spaces aside) — the same row. */
export function rowFingerprint(values: RowValues): string {
  const canonical = vehicleImportColumns.map((column) =>
    normalizeText(values[column] ?? "").toLowerCase(),
  );
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

/** What a planned row needs created before its modification. */
export interface RowNeeds {
  make?: { name: string };
  model?: { name: string };
  generation?: { name: string; yearFrom: number; yearTo: number | null };
  engine?: { code: string; fuelId: string; displacementL: number | null; powerHp: number | null };
}

export interface RowPlan {
  action: VehicleImportPlan;
  reasons: VehicleImportReason[];
  /** Resolved references (placeholders for what `needs` creates); set unless rejected. */
  resolved?: {
    makeId: string;
    makeName: string;
    modelId: string;
    modelName: string;
    generationId: string;
    identity: ModificationIdentity;
    market: VehicleMarket;
    /** The existing modification (`update`, `unchanged`). */
    modificationId?: string;
  };
  needs: RowNeeds;
}

/** Rows already seen in this file: by fingerprint and by modification identity. */
export interface SeenRows {
  fingerprints: Map<string, number>;
  identities: Map<string, number>;
}

export function newSeenRows(): SeenRows {
  return { fingerprints: new Map(), identities: new Map() };
}

function reason(
  code: VehicleImportReasonCode,
  column: VehicleImportColumn | null,
  message: string,
): VehicleImportReason {
  return { code, column, message };
}

function rejected(reasons: VehicleImportReason[]): RowPlan {
  return { action: "rejected", reasons, needs: {} };
}

function parseYear(
  value: string | undefined,
  column: VehicleImportColumn,
  reasons: VehicleImportReason[],
): number | null {
  if (value === undefined || value === "") {
    return null;
  }
  const year = /^\d{4}$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(year) || year < VEHICLE_YEAR_MIN || year > VEHICLE_YEAR_MAX) {
    reasons.push(
      reason(
        "invalid_year",
        column,
        `«${value}» is not a year from ${VEHICLE_YEAR_MIN} to ${VEHICLE_YEAR_MAX}`,
      ),
    );
    return null;
  }
  return year;
}

function parseNumber(
  value: string | undefined,
  column: VehicleImportColumn,
  { min, max, integer }: { min: number; max: number; integer: boolean },
  reasons: VehicleImportReason[],
): number | null {
  if (value === undefined || value === "") {
    return null;
  }
  // A decimal comma is what a spreadsheet in a Russian locale writes.
  const normalized = value.replace(",", ".");
  const number = /^\d+(\.\d+)?$/.test(normalized) ? Number(normalized) : Number.NaN;
  if (
    !Number.isFinite(number) ||
    number < min ||
    number > max ||
    (integer && !Number.isInteger(number))
  ) {
    reasons.push(
      reason(
        "invalid_number",
        column,
        `«${value}» is not ${integer ? "a whole number" : "a number"} from ${min} to ${max}`,
      ),
    );
    return null;
  }
  return integer ? number : Math.round(number * 100) / 100;
}

const OPTION_COLUMNS = [
  ["body", "body"],
  ["transmission", "transmission"],
  ["drive", "drive"],
] as const satisfies readonly [VehicleImportColumn, VehicleOptionKind][];

function findOption(
  snapshot: ImportSnapshot,
  kind: VehicleOptionKind,
  column: VehicleImportColumn,
  value: string,
  reasons: VehicleImportReason[],
): string | null {
  const option = snapshot.options.get(kind)!.get(nameKey(value));
  if (!option) {
    reasons.push(
      reason(
        "unknown_option",
        column,
        `No ${kind} «${value}» in the reference list; use a code or a name from the template`,
      ),
    );
    return null;
  }
  if (option.status === "archived") {
    reasons.push(reason("archived_reference", column, `The ${kind} «${value}» is archived`));
    return null;
  }
  return option.id;
}

/**
 * Plans one row against the snapshot and the rows already seen. Nothing
 * is changed: `commitRow` records what a row that isn't rejected creates.
 */
export function planRow(
  values: RowValues | null,
  snapshot: ImportSnapshot,
  seen: SeenRows,
): RowPlan {
  if (values === null) {
    return rejected([
      reason("wrong_field_count", null, "The row has more or fewer cells than the header"),
    ]);
  }
  const earlier = seen.fingerprints.get(rowFingerprint(values));
  if (earlier !== undefined) {
    return rejected([
      reason("duplicate_in_file", null, `The same row as row ${earlier} of this file`),
    ]);
  }
  const reasons: VehicleImportReason[] = [];
  const text: RowValues = {};
  for (const column of vehicleImportColumns) {
    const value = values[column];
    if (value === undefined) {
      continue;
    }
    const normalized = normalizeText(value);
    if (normalized.length > VEHICLE_IMPORT_CELL_MAX_LENGTH) {
      reasons.push(
        reason("too_long", column, `Longer than ${VEHICLE_IMPORT_CELL_MAX_LENGTH} characters`),
      );
      continue;
    }
    text[column] = normalized;
  }
  for (const column of vehicleImportRequiredColumns) {
    if (!text[column] && !reasons.some((entry) => entry.column === column)) {
      reasons.push(reason("missing_value", column, "A required value is empty"));
    }
  }

  const yearFrom = parseYear(text.year_from, "year_from", reasons);
  const yearTo = parseYear(text.year_to, "year_to", reasons);
  const generationFrom = parseYear(text.generation_year_from, "generation_year_from", reasons);
  const generationTo = parseYear(text.generation_year_to, "generation_year_to", reasons);
  if (yearFrom !== null && yearTo !== null && yearTo < yearFrom) {
    reasons.push(reason("year_order", "year_to", "The last year is before the first one"));
  }
  if (generationFrom !== null && generationTo !== null && generationTo < generationFrom) {
    reasons.push(
      reason("year_order", "generation_year_to", "The generation's last year is before its first"),
    );
  }
  if (generationTo !== null && generationFrom === null) {
    reasons.push(
      reason(
        "missing_value",
        "generation_year_from",
        "A generation's last year needs its first year too",
      ),
    );
  }
  let market: VehicleMarket | null = null;
  if (text.market) {
    const value = text.market.toLowerCase();
    if (value === "kz" || value === "global") {
      market = value;
    } else {
      reasons.push(reason("invalid_market", "market", `«${text.market}» is neither kz nor global`));
    }
  }
  const displacementL = parseNumber(
    text.engine_displacement_l,
    "engine_displacement_l",
    { min: 0.1, max: 20, integer: false },
    reasons,
  );
  const powerHp = parseNumber(
    text.engine_power_hp,
    "engine_power_hp",
    { min: 1, max: 3000, integer: true },
    reasons,
  );
  const optionIds: Partial<Record<VehicleOptionKind, string>> = {};
  for (const [column, kind] of OPTION_COLUMNS) {
    const value = text[column];
    if (value) {
      const id = findOption(snapshot, kind, column, value, reasons);
      if (id) {
        optionIds[kind] = id;
      }
    }
  }
  const fuelId = text.engine_fuel
    ? findOption(snapshot, "fuel", "engine_fuel", text.engine_fuel, reasons)
    : null;
  if (reasons.length > 0) {
    return rejected(reasons);
  }

  // Every value is well formed; now the catalog.
  const needs: RowNeeds = {};
  const makeName = text.make!;
  const make = snapshot.makes.get(spellingKey(makeName));
  if (make?.status === "archived") {
    reasons.push(reason("archived_reference", "make", `The make «${makeName}» is archived`));
  }
  const makeId = make?.id ?? "new:make";
  if (!make) {
    needs.make = { name: makeName };
  }
  const modelName = text.model!;
  const model = make ? snapshot.models.get(modelKey(make.id, modelName)) : undefined;
  if (model?.status === "archived") {
    reasons.push(reason("archived_reference", "model", `The model «${modelName}» is archived`));
  }
  const modelId = model?.id ?? "new:model";
  if (!model) {
    needs.model = { name: modelName };
  }
  const generationName = text.generation!;
  const generation = model
    ? snapshot.generations.get(generationKey(model.id, generationName))
    : undefined;
  let generationYears: { yearFrom: number; yearTo: number | null } | null = null;
  if (generation) {
    if (generation.status === "archived") {
      reasons.push(
        reason(
          "archived_reference",
          "generation",
          `The generation «${generationName}» is archived`,
        ),
      );
    }
    if (
      generationFrom !== null &&
      (generationFrom !== generation.yearFrom || generationTo !== generation.yearTo)
    ) {
      const where = generation.row === undefined ? "the catalog" : `row ${generation.row}`;
      reasons.push(
        reason(
          "generation_years_mismatch",
          "generation_year_from",
          `The generation is ${generation.yearFrom}–${generation.yearTo ?? "…"} in ${where}, not ${generationFrom}–${generationTo ?? "…"}`,
        ),
      );
    }
    generationYears = generation;
  } else if (generationFrom === null) {
    reasons.push(
      reason(
        "generation_not_found",
        "generation",
        `The model has no generation «${generationName}»; give generation_year_from to create it`,
      ),
    );
  } else {
    generationYears = { yearFrom: generationFrom, yearTo: generationTo };
    needs.generation = { name: generationName, ...generationYears };
  }
  const generationId = generation?.id ?? "new:generation";

  const engineCode = text.engine_code!;
  const engine = snapshot.engines.get(spellingKey(engineCode));
  if (engine) {
    if (engine.status === "archived") {
      reasons.push(
        reason("archived_reference", "engine_code", `The engine «${engineCode}» is archived`),
      );
    }
    const mismatches = [
      fuelId !== null && fuelId !== engine.fuelId ? "engine_fuel" : null,
      displacementL !== null &&
      engine.displacementL !== null &&
      displacementL !== engine.displacementL
        ? "engine_displacement_l"
        : null,
      powerHp !== null && engine.powerHp !== null && powerHp !== engine.powerHp
        ? "engine_power_hp"
        : null,
    ].filter((column): column is VehicleImportColumn => column !== null);
    for (const column of mismatches) {
      reasons.push(
        reason(
          "engine_mismatch",
          column,
          `The engine «${engineCode}» has another value here; the import never changes an existing engine`,
        ),
      );
    }
  } else if (fuelId === null) {
    reasons.push(
      reason("engine_fuel_required", "engine_fuel", `A new engine «${engineCode}» needs its fuel`),
    );
  } else {
    needs.engine = { code: engineCode, fuelId, displacementL, powerHp };
  }
  const engineId = engine?.id ?? "new:engine";

  const identity: ModificationIdentity = {
    generationId,
    bodyTypeId: optionIds.body!,
    engineId,
    transmissionTypeId: optionIds.transmission!,
    driveTypeId: optionIds.drive!,
    yearFrom: yearFrom!,
    yearTo,
  };
  if (generationYears && !withinYears(identity, generationYears)) {
    reasons.push(
      reason(
        "years_outside_generation",
        "year_from",
        `${identity.yearFrom}–${identity.yearTo ?? "…"} is outside the generation's ${generationYears.yearFrom}–${generationYears.yearTo ?? "…"}`,
      ),
    );
  }
  if (reasons.length > 0) {
    return rejected(reasons);
  }

  const key = identityKey(identity);
  const sameInFile = seen.identities.get(key);
  if (sameInFile !== undefined) {
    return rejected([
      reason("duplicate_in_file", null, `The same modification as row ${sameInFile} of this file`),
    ]);
  }
  const resolved = {
    makeId,
    makeName,
    modelId,
    modelName,
    generationId,
    identity,
    market: market!,
  };
  const existing = snapshot.modifications.get(key);
  if (!existing) {
    return { action: "create", reasons: [], resolved, needs };
  }
  if (existing.status === "archived") {
    return rejected([
      reason(
        "matches_archived",
        null,
        "This modification exists and is archived; restore it by hand if it is needed",
      ),
    ]);
  }
  return {
    action: existing.market === market ? "unchanged" : "update",
    reasons: [],
    resolved: { ...resolved, modificationId: existing.id },
    needs,
  };
}

/** The ids of what a row created (placeholders when the report is made). */
export interface CreatedIds {
  makeId?: string;
  modelId?: string;
  generationId?: string;
  engineId?: string;
  modificationId?: string;
}

/**
 * Records a row that isn't rejected in the snapshot and among the rows
 * seen: what it creates exists for the rows after it.
 */
export function commitRow(
  rowNumber: number,
  values: RowValues,
  plan: RowPlan,
  created: CreatedIds,
  snapshot: ImportSnapshot,
  seen: SeenRows,
): void {
  seen.fingerprints.set(rowFingerprint(values), rowNumber);
  if (plan.action === "rejected" || !plan.resolved) {
    return;
  }
  const { needs, resolved } = plan;
  const makeId = needs.make ? created.makeId! : resolved.makeId;
  if (needs.make) {
    snapshot.makes.set(spellingKey(needs.make.name), { id: makeId, status: "active" });
  }
  const modelId = needs.model ? created.modelId! : resolved.modelId;
  if (needs.model) {
    snapshot.models.set(modelKey(makeId, needs.model.name), { id: modelId, status: "active" });
  }
  const generationId = needs.generation ? created.generationId! : resolved.generationId;
  if (needs.generation) {
    snapshot.generations.set(generationKey(modelId, needs.generation.name), {
      id: generationId,
      status: "active",
      yearFrom: needs.generation.yearFrom,
      yearTo: needs.generation.yearTo,
      row: rowNumber,
    });
  }
  const engineId = needs.engine ? created.engineId! : resolved.identity.engineId;
  if (needs.engine) {
    snapshot.engines.set(spellingKey(needs.engine.code), {
      id: engineId,
      status: "active",
      fuelId: needs.engine.fuelId,
      displacementL: needs.engine.displacementL,
      powerHp: needs.engine.powerHp,
    });
  }
  const identity = { ...resolved.identity, generationId, engineId };
  const key = identityKey(identity);
  seen.identities.set(key, rowNumber);
  snapshot.modifications.set(key, {
    id: created.modificationId ?? resolved.modificationId!,
    status: "active",
    market: resolved.market,
  });
}

/** Placeholder ids for what a planned row would create (the report). */
export function placeholderIds(rowNumber: number, needs: RowNeeds): CreatedIds {
  return {
    makeId: needs.make ? `new:make:${rowNumber}` : undefined,
    modelId: needs.model ? `new:model:${rowNumber}` : undefined,
    generationId: needs.generation ? `new:generation:${rowNumber}` : undefined,
    engineId: needs.engine ? `new:engine:${rowNumber}` : undefined,
    modificationId: `new:modification:${rowNumber}`,
  };
}

/** One planned row, as the report is built from it. */
export interface PlannedRow {
  rowNumber: number;
  plan: RowPlan;
}

/** The report before applying (A-CAR-02) from the planned rows in file order. */
export function buildReport(rows: readonly PlannedRow[]): VehicleImportReport {
  const report: VehicleImportReport = {
    create: 0,
    update: 0,
    unchanged: 0,
    rejected: 0,
    newMakes: [],
    newModels: [],
    newGenerations: [],
    newEngines: [],
    rejectedRows: [],
  };
  for (const { rowNumber, plan } of rows) {
    report[plan.action] += 1;
    if (plan.action === "rejected") {
      if (report.rejectedRows.length < VEHICLE_IMPORT_REPORT_REJECTED_MAX) {
        report.rejectedRows.push({ row: rowNumber, reasons: plan.reasons });
      }
      continue;
    }
    const { needs, resolved } = plan;
    if (needs.make) {
      report.newMakes.push({ row: rowNumber, name: needs.make.name });
    }
    if (needs.model) {
      report.newModels.push({ row: rowNumber, make: resolved!.makeName, name: needs.model.name });
    }
    if (needs.generation) {
      report.newGenerations.push({
        row: rowNumber,
        make: resolved!.makeName,
        model: resolved!.modelName,
        name: needs.generation.name,
        yearFrom: needs.generation.yearFrom,
        yearTo: needs.generation.yearTo,
      });
    }
    if (needs.engine) {
      report.newEngines.push({ row: rowNumber, code: needs.engine.code });
    }
  }
  return report;
}
