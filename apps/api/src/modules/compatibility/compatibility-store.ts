import type {
  AdminCompatibilityProposal,
  AdminCompatibilityRecord,
  CompatibilityConditions,
  SupplierCompatibilityProposal,
} from "@adclub/contracts";
import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { DbExecutor } from "../../database";
import { supplier } from "../identity";
import { brandSpelling, catalogItem, translation } from "../catalog";
import { conditionsOf, describeConditions } from "./compatibility-conditions";
import { itemArchived, notApplicable, notFound } from "./compatibility-errors";
import {
  itemCompatibility,
  itemCompatibilityProposal,
  type ItemCompatibilityProposalRow,
  type ItemCompatibilityRow,
} from "./schema";

/** Shared reading and locking of records and proposals (ARCHITECTURE 4.25). */

export type CatalogItemRow = typeof catalogItem.$inferSelect;

/**
 * The vehicle catalog may not change under a check that spans its rows
 * (a model of the make, a generation of the model): compatibility writes
 * take its lock shared — they don't wait on each other, only on a change
 * of the vehicle catalog (which takes it exclusively, ARCHITECTURE 4.24 I219).
 */
export const VEHICLE_LOCK_SHARED = sql`SELECT pg_advisory_xact_lock_shared(hashtext('vehicle_catalog'))`;

/** Every change of an item's compatibility takes the item's lock: checks for duplicates can't race. */
export function itemLock(itemId: string): SQL {
  return sql`SELECT pg_advisory_xact_lock(hashtext('item_compatibility'), hashtext(${itemId}))`;
}

/** The item, or 404. */
export async function findItem(executor: DbExecutor, itemId: string): Promise<CatalogItemRow> {
  const [row] = await executor.select().from(catalogItem).where(eq(catalogItem.id, itemId));
  if (!row) {
    throw notFound("item");
  }
  return row;
}

/** An item compatibility can be written for: a part or a product that isn't archived. */
export function assertWritable(item: CatalogItemRow): asserts item is CatalogItemRow & {
  itemType: "part" | "generic";
} {
  if (item.itemType === "service") {
    throw notApplicable();
  }
  if (item.status === "archived") {
    throw itemArchived();
  }
}

/** A nullable column equal to a value, `NULL` equal to `NULL`. */
function equalOrBothNull(column: AnyPgColumn, value: string | number | null): SQL {
  return value === null ? isNull(column) : eq(column, value);
}

/** The condition columns equal to `conditions` (`NULL` equal to `NULL`). */
export function sameConditionsWhere(
  table: typeof itemCompatibility | typeof itemCompatibilityProposal,
  conditions: CompatibilityConditions,
): SQL {
  return and(
    eq(table.makeId, conditions.makeId),
    equalOrBothNull(table.modelId, conditions.modelId),
    equalOrBothNull(table.generationId, conditions.generationId),
    equalOrBothNull(table.bodyTypeId, conditions.bodyTypeId),
    equalOrBothNull(table.engineId, conditions.engineId),
    equalOrBothNull(table.transmissionTypeId, conditions.transmissionTypeId),
    equalOrBothNull(table.driveTypeId, conditions.driveTypeId),
    equalOrBothNull(table.yearFrom, conditions.yearFrom),
    equalOrBothNull(table.yearTo, conditions.yearTo),
  )!;
}

/** The approved record of the item with exactly these conditions, if any. */
export async function approvedMatch(
  executor: DbExecutor,
  itemId: string,
  conditions: CompatibilityConditions,
  exceptId?: string,
): Promise<ItemCompatibilityRow | null> {
  const rows = await executor
    .select()
    .from(itemCompatibility)
    .where(
      and(
        eq(itemCompatibility.itemId, itemId),
        eq(itemCompatibility.status, "approved"),
        sameConditionsWhere(itemCompatibility, conditions),
      ),
    );
  return rows.find((row) => row.id !== exceptId) ?? null;
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/** Records as the admin panel shows them, with the conditions in words. */
export async function describeRecords(
  executor: DbExecutor,
  rows: readonly ItemCompatibilityRow[],
): Promise<AdminCompatibilityRecord[]> {
  if (rows.length === 0) {
    return [];
  }
  const [labels, sources] = await Promise.all([
    describeConditions(executor, rows),
    executor
      .select({
        id: itemCompatibilityProposal.id,
        recordId: itemCompatibilityProposal.compatibilityId,
      })
      .from(itemCompatibilityProposal)
      .where(
        and(
          inArray(
            itemCompatibilityProposal.compatibilityId,
            rows.map((row) => row.id),
          ),
          eq(itemCompatibilityProposal.resolution, "created"),
        ),
      ),
  ]);
  const proposalOf = new Map(sources.map((entry) => [entry.recordId, entry.id]));
  return rows.map((row, index) => ({
    id: row.id,
    itemId: row.itemId,
    conditions: conditionsOf(row),
    label: labels[index]!,
    status: row.status,
    source: row.source,
    evidence: row.evidence,
    copiedFromId: row.copiedFromId,
    proposalId: proposalOf.get(row.id) ?? null,
    reviewedByAdminId: row.reviewedByAdminId,
    reviewedAt: row.reviewedAt.toISOString(),
    version: row.version,
    archivedAt: iso(row.archivedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

/** Proposals as their supplier sees them. */
export async function describeSupplierProposals(
  executor: DbExecutor,
  rows: readonly ItemCompatibilityProposalRow[],
): Promise<SupplierCompatibilityProposal[]> {
  const labels = await describeConditions(executor, rows);
  return rows.map((row, index) => ({
    id: row.id,
    itemId: row.itemId,
    conditions: conditionsOf(row),
    label: labels[index]!,
    evidence: row.evidence,
    status: row.status,
    resolution: row.resolution,
    approvedWithChanges: row.approvedWithChanges,
    rejectionReason: row.rejectionReason,
    createdAt: row.createdAt.toISOString(),
    reviewedAt: iso(row.reviewedAt),
  }));
}

/**
 * Proposals as the moderation queue shows them: the item (brand, article,
 * Russian name), the company, and the approved record they would repeat.
 */
export async function describeAdminProposals(
  executor: DbExecutor,
  rows: readonly ItemCompatibilityProposalRow[],
): Promise<AdminCompatibilityProposal[]> {
  if (rows.length === 0) {
    return [];
  }
  const itemIds = [...new Set(rows.map((row) => row.itemId))];
  const supplierIds = [
    ...new Set(rows.map((row) => row.supplierId).filter((id): id is string => id !== null)),
  ];
  const [base, items, names, companies, approved] = await Promise.all([
    describeSupplierProposals(executor, rows),
    executor.select().from(catalogItem).where(inArray(catalogItem.id, itemIds)),
    executor
      .select({ entityId: translation.entityId, text: translation.text })
      .from(translation)
      .where(
        and(
          eq(translation.entityType, "catalog_item"),
          inArray(translation.entityId, itemIds),
          eq(translation.field, "name"),
          eq(translation.lang, "ru"),
        ),
      ),
    supplierIds.length === 0
      ? []
      : executor
          .select({ id: supplier.id, name: supplier.name })
          .from(supplier)
          .where(inArray(supplier.id, supplierIds)),
    executor
      .select()
      .from(itemCompatibility)
      .where(
        and(inArray(itemCompatibility.itemId, itemIds), eq(itemCompatibility.status, "approved")),
      ),
  ]);
  const brandIds = [
    ...new Set(items.map((item) => item.brandId).filter((id): id is string => id !== null)),
  ];
  const brands =
    brandIds.length === 0
      ? []
      : await executor
          .select({ id: brandSpelling.brandId, text: brandSpelling.text })
          .from(brandSpelling)
          .where(and(inArray(brandSpelling.brandId, brandIds), eq(brandSpelling.isName, true)));
  const itemById = new Map(items.map((item) => [item.id, item]));
  const nameOf = new Map(names.map((entry) => [entry.entityId, entry.text]));
  const brandOf = new Map(brands.map((entry) => [entry.id, entry.text]));
  const companyOf = new Map(companies.map((entry) => [entry.id, entry]));
  return rows.map((row, index) => {
    const item = itemById.get(row.itemId)!;
    const conditions = conditionsOf(row);
    const match = approved.find(
      (record) =>
        record.itemId === row.itemId &&
        JSON.stringify(conditionsOf(record)) === JSON.stringify(conditions),
    );
    return {
      ...base[index]!,
      source: row.source,
      item: {
        id: item.id,
        type: item.itemType === "service" ? "part" : item.itemType,
        brand: item.brandId ? (brandOf.get(item.brandId) ?? null) : null,
        article: item.article,
        name: nameOf.get(item.id) ?? null,
        status: item.status,
      },
      supplier: row.supplierId ? (companyOf.get(row.supplierId) ?? null) : null,
      supplierMemberId: row.supplierMemberId,
      matchesRecordId: match?.id ?? null,
      recordId: row.compatibilityId,
      reviewedByAdminId: row.reviewedByAdminId,
    };
  });
}
