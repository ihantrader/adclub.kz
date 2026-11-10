import type {
  MaintenanceScope,
  MaintenanceScopeInput,
  MaintenanceScopeLabel,
} from "@adclub/contracts";
import type { MaintenanceCar } from "@adclub/domain";
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { DbExecutor } from "../../database";
import { describeConditions } from "../compatibility";
import { vehicleEngine, vehicleGeneration, vehicleMake, vehicleModel } from "../vehicles";
import { scopeInvalid } from "./maintenance-errors";
import { maintenancePlan, type MaintenancePlanRow } from "./schema";

/**
 * The area of a plan against the vehicle catalog (ARCHITECTURE 4.84): the
 * levels agree as a compatibility record's do — the model of a generation
 * is filled in when left out and must be the generation's when given, the
 * model must be of the make. Archived rows are accepted (a plan of an old
 * car is still its plan); they only make it invisible to cars.
 */
export async function resolveScope(
  executor: DbExecutor,
  input: MaintenanceScopeInput,
): Promise<MaintenanceScope> {
  const scope: MaintenanceScope = {
    makeId: input.makeId,
    modelId: input.modelId ?? null,
    generationId: input.generationId ?? null,
    engineId: input.engineId ?? null,
  };
  const [make] = await executor
    .select({ id: vehicleMake.id })
    .from(vehicleMake)
    .where(eq(vehicleMake.id, scope.makeId));
  if (!make) throw scopeInvalid("not_found", "makeId");
  if (scope.generationId) {
    const [generation] = await executor
      .select({ modelId: vehicleGeneration.modelId })
      .from(vehicleGeneration)
      .where(eq(vehicleGeneration.id, scope.generationId));
    if (!generation) throw scopeInvalid("not_found", "generationId");
    if (scope.modelId && scope.modelId !== generation.modelId) {
      throw scopeInvalid("generation_of_other_model", "generationId");
    }
    scope.modelId = generation.modelId;
  }
  if (scope.modelId) {
    const [model] = await executor
      .select({ makeId: vehicleModel.makeId })
      .from(vehicleModel)
      .where(eq(vehicleModel.id, scope.modelId));
    if (!model) throw scopeInvalid("not_found", "modelId");
    if (model.makeId !== scope.makeId) throw scopeInvalid("model_of_other_make", "modelId");
  }
  if (scope.engineId) {
    const [engine] = await executor
      .select({ id: vehicleEngine.id })
      .from(vehicleEngine)
      .where(eq(vehicleEngine.id, scope.engineId));
    if (!engine) throw scopeInvalid("not_found", "engineId");
  }
  return scope;
}

export function scopeOf(row: MaintenancePlanRow): MaintenanceScope {
  return {
    makeId: row.makeId,
    modelId: row.modelId,
    generationId: row.generationId,
    engineId: row.engineId,
  };
}

export function sameScope(a: MaintenanceScope, b: MaintenanceScope): boolean {
  return (
    a.makeId === b.makeId &&
    a.modelId === b.modelId &&
    a.generationId === b.generationId &&
    a.engineId === b.engineId
  );
}

/** The areas in words — the very words of compatibility records (one function for both). */
export async function describeScopes(
  executor: DbExecutor,
  scopes: readonly MaintenanceScope[],
): Promise<MaintenanceScopeLabel[]> {
  const labels = await describeConditions(
    executor,
    scopes.map((scope) => ({
      ...scope,
      bodyTypeId: null,
      transmissionTypeId: null,
      driveTypeId: null,
      yearFrom: null,
      yearTo: null,
    })),
  );
  return labels.map((label) => ({
    make: label.make,
    model: label.model,
    generation: label.generation,
    engine: label.engine,
  }));
}

/** «Geely · Atlas · II (FX11) (с 2023) · JLH-4G20TD». */
export function scopeText(label: MaintenanceScopeLabel): string {
  return [label.make, label.model, label.generation, label.engine].filter(Boolean).join(" · ");
}

function equalOrBothNull(column: AnyPgColumn, value: string | null): SQL {
  return value === null ? isNull(column) : eq(column, value);
}

/** The plans of exactly this area (`NULL` equal to `NULL`). */
export function sameScopeWhere(scope: MaintenanceScope): SQL {
  return and(
    eq(maintenancePlan.makeId, scope.makeId),
    equalOrBothNull(maintenancePlan.modelId, scope.modelId),
    equalOrBothNull(maintenancePlan.generationId, scope.generationId),
    equalOrBothNull(maintenancePlan.engineId, scope.engineId),
  )!;
}

/**
 * The SQL twin of `maintenanceScopeMatches` (`@adclub/domain`) for the
 * plans a car may get: active, of its make, no level contradicting a known
 * level of the car, and every level of the plan active in the vehicle
 * catalog (an archived make, model, generation or engine makes the plan
 * invisible to cars without changing its status). It only narrows the
 * candidates: which of them applies — or which levels to ask for — the
 * domain function decides (`maintenancePlanFor`).
 */
export function planCandidatesWhere(car: MaintenanceCar & { makeId: string }): SQL {
  const level = (column: AnyPgColumn, known: string | null): SQL =>
    known === null ? sql`TRUE` : sql`(${column} IS NULL OR ${column} = ${known})`;
  return and(
    eq(maintenancePlan.status, "active"),
    eq(maintenancePlan.makeId, car.makeId),
    level(maintenancePlan.modelId, car.modelId),
    level(maintenancePlan.generationId, car.generationId),
    level(maintenancePlan.engineId, car.engineId),
    sql`EXISTS (SELECT 1 FROM ${vehicleMake} WHERE ${vehicleMake.id} = ${maintenancePlan.makeId} AND ${vehicleMake.status} = 'active')`,
    sql`(${maintenancePlan.modelId} IS NULL OR EXISTS (SELECT 1 FROM ${vehicleModel} WHERE ${vehicleModel.id} = ${maintenancePlan.modelId} AND ${vehicleModel.status} = 'active'))`,
    sql`(${maintenancePlan.generationId} IS NULL OR EXISTS (SELECT 1 FROM ${vehicleGeneration} WHERE ${vehicleGeneration.id} = ${maintenancePlan.generationId} AND ${vehicleGeneration.status} = 'active'))`,
    sql`(${maintenancePlan.engineId} IS NULL OR EXISTS (SELECT 1 FROM ${vehicleEngine} WHERE ${vehicleEngine.id} = ${maintenancePlan.engineId} AND ${vehicleEngine.status} = 'active'))`,
  )!;
}
