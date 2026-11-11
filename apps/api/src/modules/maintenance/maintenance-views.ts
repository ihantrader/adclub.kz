import type {
  AdminMaintenanceItem,
  AdminMaintenancePlan,
  AdminMaintenancePlanResponse,
} from "@adclub/contracts";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import type { DbExecutor } from "../../database";
import { describeTexts, loadTexts, textsOf } from "../catalog";
import { account, adminUser } from "../identity";
import { describeScopes, generatingNow, sameScopeWhere, scopeOf } from "./maintenance-scope";
import { describeTargets, targetOf } from "./maintenance-targets";
import {
  maintenancePlan,
  maintenancePlanItem,
  type MaintenancePlanItemRow,
  type MaintenancePlanRow,
} from "./schema";

/** What the admin panel sees of plans and their elements (ARCHITECTURE 4.84). */

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

/** The names of administrators (their accounts' names), for «кто подтвердил». */
async function adminNames(
  executor: DbExecutor,
  ids: readonly (string | null)[],
): Promise<Map<string, string | null>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  if (wanted.length === 0) return new Map();
  const rows = await executor
    .select({ id: adminUser.id, name: account.name })
    .from(adminUser)
    .innerJoin(account, eq(account.id, adminUser.accountId))
    .where(inArray(adminUser.id, wanted));
  return new Map(rows.map((row) => [row.id, row.name]));
}

function person(names: Map<string, string | null>, id: string | null) {
  return id === null ? null : { adminId: id, name: names.get(id) ?? null };
}

/** Elements in the plan's order, archived ones last. */
export function itemOrder(a: MaintenancePlanItemRow, b: MaintenancePlanItemRow): number {
  const archived = (row: MaintenancePlanItemRow) => (row.status === "archived" ? 1 : 0);
  return archived(a) - archived(b) || a.position - b.position || a.id.localeCompare(b.id);
}

export async function describePlans(
  executor: DbExecutor,
  rows: readonly MaintenancePlanRow[],
): Promise<AdminMaintenancePlan[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const [labels, counts, names] = await Promise.all([
    describeScopes(executor, rows.map(scopeOf)),
    executor
      .select({ planId: maintenancePlanItem.planId, status: maintenancePlanItem.status })
      .from(maintenancePlanItem)
      .where(
        and(inArray(maintenancePlanItem.planId, ids), ne(maintenancePlanItem.status, "archived")),
      ),
    adminNames(
      executor,
      rows.flatMap((row) => [row.createdByAdminId, row.confirmedByAdminId]),
    ),
  ]);
  return rows.map((row, index) => {
    const own = counts.filter((entry) => entry.planId === row.id);
    return {
      id: row.id,
      scope: scopeOf(row),
      label: labels[index]!,
      name: row.name,
      source: row.source,
      status: row.status,
      generating: generatingNow(row),
      itemCount: own.length,
      proposedCount: own.filter((entry) => entry.status === "proposed").length,
      copiedFromId: row.copiedFromId,
      createdBy: person(names, row.createdByAdminId),
      confirmedBy: person(names, row.confirmedByAdminId),
      confirmedAt: iso(row.confirmedAt),
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  });
}

export async function describeItems(
  executor: DbExecutor,
  rows: readonly MaintenancePlanItemRow[],
): Promise<AdminMaintenanceItem[]> {
  if (rows.length === 0) return [];
  const [targets, texts, names] = await Promise.all([
    describeTargets(executor, rows),
    loadTexts(
      executor,
      "maintenance_plan_item",
      rows.map((row) => row.id),
    ),
    adminNames(
      executor,
      rows.map((row) => row.confirmedByAdminId),
    ),
  ]);
  return rows.map((row, index) => ({
    id: row.id,
    planId: row.planId,
    position: row.position,
    kind: row.kind,
    title: describeTexts(textsOf(texts, row.id, "name")),
    intervalKm: row.intervalKm,
    intervalMonths: row.intervalMonths,
    firstKm: row.firstKm,
    firstMonths: row.firstMonths,
    serviceCodes: row.serviceCodes,
    target: targetOf(row),
    targetLabel: targets[index]!.label,
    quantity: row.quantity,
    note: row.note,
    status: row.status,
    problems: targets[index]!.problems,
    confirmedBy: person(names, row.confirmedByAdminId),
    confirmedAt: iso(row.confirmedAt),
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

/** A plan with its elements, and the active plan of the same area if it is another one. */
export async function planResponse(
  executor: DbExecutor,
  plan: MaintenancePlanRow,
): Promise<AdminMaintenancePlanResponse> {
  const [items, [active]] = await Promise.all([
    executor
      .select()
      .from(maintenancePlanItem)
      .where(eq(maintenancePlanItem.planId, plan.id))
      .orderBy(asc(maintenancePlanItem.position), asc(maintenancePlanItem.id)),
    executor
      .select({ id: maintenancePlan.id })
      .from(maintenancePlan)
      .where(and(sameScopeWhere(scopeOf(plan)), eq(maintenancePlan.status, "active"))),
  ]);
  const [described] = await describePlans(executor, [plan]);
  return {
    plan: described!,
    items: await describeItems(executor, [...items].sort(itemOrder)),
    activePlanId: active && active.id !== plan.id ? active.id : null,
  };
}
