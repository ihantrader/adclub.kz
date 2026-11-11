import type {
  MaintenanceItemKind,
  MaintenanceItemProblem,
  MaintenanceTarget,
  ShowcaseAttributeFilter,
} from "@adclub/contracts";
import { and, eq, inArray } from "drizzle-orm";
import type { DbExecutor } from "../../database";
import { attribute, attributeOption, catalogItem, category, loadTexts, textsOf } from "../catalog";
import { targetInvalid } from "./maintenance-errors";
import type { MaintenancePlanItemRow } from "./schema";

/**
 * The rule of an element against the catalog (ARCHITECTURE 4.84): a rule
 * names only what the catalog has — an active subcategory of the element's
 * kind and conditions by its active filters, or active items of that kind.
 * What is checked when a rule is written is checked again as «problems»
 * when it is read: the catalog changes under a plan (a subcategory hidden,
 * an item archived), and the administrator is told before the plan is
 * activated and while it is active (TASK-061, edge cases).
 */

const CATEGORY_KIND: Record<MaintenanceItemKind, "goods" | "services"> = {
  part: "goods",
  service: "services",
};

/** The rule as stored. */
export interface StoredTarget {
  targetKind: "category" | "items" | null;
  targetCategoryId: string | null;
  targetCategoryKind: "goods" | "services" | null;
  targetAttributes: ShowcaseAttributeFilter[];
  targetItemIds: string[];
}

export function storedTarget(
  kind: MaintenanceItemKind,
  target: MaintenanceTarget | null,
): StoredTarget {
  if (target === null) {
    return {
      targetKind: null,
      targetCategoryId: null,
      targetCategoryKind: null,
      targetAttributes: [],
      targetItemIds: [],
    };
  }
  return target.kind === "category"
    ? {
        targetKind: "category",
        targetCategoryId: target.categoryId,
        targetCategoryKind: CATEGORY_KIND[kind],
        targetAttributes: target.attributes.map(cleanFilter),
        targetItemIds: [],
      }
    : {
        targetKind: "items",
        targetCategoryId: null,
        targetCategoryKind: null,
        targetAttributes: [],
        targetItemIds: [...new Set(target.itemIds)],
      };
}

/** A filter with only its own fields (the stored JSON stays the filter of the client list). */
function cleanFilter(filter: ShowcaseAttributeFilter): ShowcaseAttributeFilter {
  return {
    attributeId: filter.attributeId,
    ...(filter.optionIds ? { optionIds: [...filter.optionIds] } : {}),
    ...(filter.min !== undefined ? { min: filter.min } : {}),
    ...(filter.max !== undefined ? { max: filter.max } : {}),
    ...(filter.value !== undefined ? { value: filter.value } : {}),
  };
}

export function targetOf(row: MaintenancePlanItemRow): MaintenanceTarget | null {
  if (row.targetKind === "category" && row.targetCategoryId) {
    return { kind: "category", categoryId: row.targetCategoryId, attributes: row.targetAttributes };
  }
  if (row.targetKind === "items") {
    return { kind: "items", itemIds: row.targetItemIds };
  }
  return null;
}

/** An active subcategory under an active node, of this kind (what the client list shows). */
async function usableSubcategory(
  executor: DbExecutor,
  categoryId: string,
  kind: "goods" | "services",
): Promise<boolean> {
  const [row] = await executor.select().from(category).where(eq(category.id, categoryId));
  if (!row || row.status !== "active" || row.level !== 2 || row.kind !== kind || !row.parentId) {
    return false;
  }
  const [parent] = await executor
    .select({ status: category.status })
    .from(category)
    .where(eq(category.id, row.parentId));
  return parent?.status === "active";
}

/**
 * Throws `MAINTENANCE_TARGET_INVALID` unless the rule leads to the catalog
 * as it is now. `path` is where the rule is in the body (`target`).
 */
export async function assertTarget(
  executor: DbExecutor,
  kind: MaintenanceItemKind,
  target: MaintenanceTarget,
  path = "target",
): Promise<void> {
  if (target.kind === "items") {
    const ids = [...new Set(target.itemIds)];
    const rows = await executor
      .select({ id: catalogItem.id, status: catalogItem.status, type: catalogItem.itemType })
      .from(catalogItem)
      .where(inArray(catalogItem.id, ids));
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const [index, id] of target.itemIds.entries()) {
      const row = byId.get(id);
      const ofKind = row && (kind === "service" ? row.type === "service" : row.type !== "service");
      if (!row || row.status !== "active" || !ofKind) {
        throw targetInvalid("item", `${path}.itemIds.${String(index)}`);
      }
    }
    return;
  }
  if (!(await usableSubcategory(executor, target.categoryId, CATEGORY_KIND[kind]))) {
    throw targetInvalid("category", `${path}.categoryId`);
  }
  if (target.attributes.length === 0) return;
  const attributes = await executor
    .select()
    .from(attribute)
    .where(
      and(
        eq(attribute.categoryId, target.categoryId),
        eq(attribute.status, "active"),
        eq(attribute.isFilterable, true),
      ),
    );
  const byId = new Map(attributes.map((row) => [row.id, row]));
  const seen = new Set<string>();
  for (const [index, filter] of target.attributes.entries()) {
    const at = `${path}.attributes.${String(index)}`;
    const definition = byId.get(filter.attributeId);
    if (!definition || seen.has(filter.attributeId)) {
      throw targetInvalid("attribute", `${at}.attributeId`);
    }
    seen.add(filter.attributeId);
    const fits =
      (definition.valueType === "enum" && filter.optionIds !== undefined) ||
      (definition.valueType === "number" &&
        (filter.min !== undefined || filter.max !== undefined)) ||
      (definition.valueType === "bool" && filter.value !== undefined);
    if (!fits) throw targetInvalid("attribute", at);
    if (filter.optionIds) {
      const options = await executor
        .select({ id: attributeOption.id })
        .from(attributeOption)
        .where(
          and(
            eq(attributeOption.attributeId, definition.id),
            eq(attributeOption.status, "active"),
            inArray(attributeOption.id, filter.optionIds),
          ),
        );
      if (options.length !== new Set(filter.optionIds).size) {
        throw targetInvalid("option", `${at}.optionIds`);
      }
    }
  }
}

/**
 * Whether the rule of each element leads to the catalog as it is now — its
 * problems, empty when it does (TASK-061.A; ARCHITECTURE 4.84 I947). The one
 * rule for the administrator (the card, «Проверить», activation) and the
 * client (`GET /maintenance/plan`: an element with a problem sells nothing).
 */
export async function targetProblems(
  executor: DbExecutor,
  rows: readonly MaintenancePlanItemRow[],
): Promise<MaintenanceItemProblem[][]> {
  return (await describeTargets(executor, rows)).map((target) => target.problems);
}

export interface DescribedTarget {
  label: string | null;
  problems: MaintenanceItemProblem[];
}

const numberText = (value: number) =>
  new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3, useGrouping: false }).format(value);

/**
 * The rules of many elements in words («Моторные масла · Вязкость: 0W-20,
 * 5W-30 · Объём: от 4 л», «Позиции: 04465-0K090, GDB3534») with their
 * problems against the catalog now — a handful of queries whatever their
 * number.
 */
export async function describeTargets(
  executor: DbExecutor,
  rows: readonly MaintenancePlanItemRow[],
): Promise<DescribedTarget[]> {
  const categoryIds = [
    ...new Set(rows.map((row) => row.targetCategoryId).filter((id): id is string => id !== null)),
  ];
  const itemIds = [...new Set(rows.flatMap((row) => row.targetItemIds))];
  const attributeIds = [
    ...new Set(rows.flatMap((row) => row.targetAttributes.map((filter) => filter.attributeId))),
  ];
  const optionIds = [
    ...new Set(
      rows.flatMap((row) => row.targetAttributes.flatMap((filter) => filter.optionIds ?? [])),
    ),
  ];
  const [categories, attributes, options, items] = await Promise.all([
    categoryIds.length === 0
      ? []
      : executor.select().from(category).where(inArray(category.id, categoryIds)),
    attributeIds.length === 0
      ? []
      : executor.select().from(attribute).where(inArray(attribute.id, attributeIds)),
    optionIds.length === 0
      ? []
      : executor.select().from(attributeOption).where(inArray(attributeOption.id, optionIds)),
    itemIds.length === 0
      ? []
      : executor.select().from(catalogItem).where(inArray(catalogItem.id, itemIds)),
  ]);
  const parentIds = [
    ...new Set(categories.map((row) => row.parentId).filter((id): id is string => id !== null)),
  ];
  const [parents, categoryTexts, attributeTexts, optionTexts, itemTexts] = await Promise.all([
    parentIds.length === 0
      ? []
      : executor
          .select({ id: category.id, status: category.status })
          .from(category)
          .where(inArray(category.id, parentIds)),
    loadTexts(executor, "category", categoryIds),
    loadTexts(executor, "attribute", attributeIds),
    loadTexts(executor, "attribute_option", optionIds),
    loadTexts(executor, "catalog_item", itemIds),
  ]);
  const categoryById = new Map(categories.map((row) => [row.id, row]));
  const parentStatus = new Map(parents.map((row) => [row.id, row.status]));
  const attributeById = new Map(attributes.map((row) => [row.id, row]));
  const optionById = new Map(options.map((row) => [row.id, row]));
  const itemById = new Map(items.map((row) => [row.id, row]));
  const ru = (index: typeof categoryTexts, id: string, field: "name" | "unit" = "name") =>
    textsOf(index, id, field).ru?.text ?? null;

  return rows.map((row) => {
    if (row.targetKind === null) return { label: null, problems: ["no_rule"] };
    const problems = new Set<MaintenanceItemProblem>();
    if (row.targetKind === "items") {
      const names = row.targetItemIds.map((id) => {
        const item = itemById.get(id);
        const ofKind =
          item &&
          (row.kind === "service" ? item.itemType === "service" : item.itemType !== "service");
        if (!item || item.status !== "active" || !ofKind) problems.add("item_unavailable");
        return item?.article ?? ru(itemTexts, id) ?? "позиция не найдена";
      });
      return { label: `Позиции: ${names.join(", ")}`, problems: [...problems] };
    }
    const subcategory = row.targetCategoryId ? categoryById.get(row.targetCategoryId) : undefined;
    if (
      !subcategory ||
      subcategory.status !== "active" ||
      !subcategory.parentId ||
      parentStatus.get(subcategory.parentId) !== "active"
    ) {
      problems.add("category_unavailable");
    }
    const parts = [
      subcategory
        ? (ru(categoryTexts, subcategory.id) ?? subcategory.code)
        : "подкатегория не найдена",
    ];
    for (const filter of row.targetAttributes) {
      const definition = attributeById.get(filter.attributeId);
      if (
        !definition ||
        definition.status !== "active" ||
        !definition.isFilterable ||
        definition.categoryId !== row.targetCategoryId
      ) {
        problems.add("attribute_unavailable");
      }
      const name = definition
        ? (ru(attributeTexts, definition.id) ?? definition.code)
        : "характеристика";
      const unit = definition ? ru(attributeTexts, definition.id, "unit") : null;
      const withUnit = (value: number) => `${numberText(value)}${unit ? ` ${unit}` : ""}`;
      let value: string;
      if (filter.optionIds) {
        value = filter.optionIds
          .map((id) => {
            const option = optionById.get(id);
            if (!option || option.status !== "active") problems.add("attribute_unavailable");
            return option ? (ru(optionTexts, id) ?? option.code) : "вариант не найден";
          })
          .join(", ");
      } else if (filter.value !== undefined) {
        value = filter.value ? "да" : "нет";
      } else if (filter.min !== undefined && filter.max !== undefined) {
        value =
          filter.min === filter.max
            ? withUnit(filter.min)
            : `от ${withUnit(filter.min)} до ${withUnit(filter.max)}`;
      } else if (filter.min !== undefined) {
        value = `от ${withUnit(filter.min)}`;
      } else {
        value = `до ${withUnit(filter.max ?? 0)}`;
      }
      parts.push(`${name}: ${value}`);
    }
    return { label: parts.join(" · "), problems: [...problems] };
  });
}
