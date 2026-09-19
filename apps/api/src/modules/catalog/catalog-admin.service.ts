import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  auditActions,
  auditEntities,
  type AdminAttribute,
  type AdminAttributeListResponse,
  type AdminAttributeOption,
  type AdminCategory,
  type AdminCategoryTreeResponse,
  type CatalogEntryStatus,
  type CatalogLanguage,
  type CategoryIcon,
  type CategoryKind,
  type CategoryStatus,
  type CreateAttributeBody,
  type CreateAttributeOptionBody,
  type CreateCategoryBody,
  type NumberSettings,
  type UpdateAttributeBody,
  type UpdateAttributeOptionBody,
  type UpdateCategoryBody,
} from "@adclub/contracts";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { DatabaseService, type DbExecutor } from "../../database";
import { AuditLog, type AuditActorRecord } from "../audit";
import {
  attributeTypeImmutable,
  codeTaken,
  depthExceeded,
  kindMismatch,
  levelImmutable,
  nameTaken,
  notFound,
  notSubcategory,
  orderConflict,
  orderMismatch,
  parentArchived,
  validationError,
  versionConflict,
} from "./catalog-errors";
import { STRUCTURE_LOCK } from "./catalog-locks";
import {
  describeTexts,
  languagesOf,
  loadTexts,
  mergeTexts,
  nameKey,
  plainTexts,
  textsOf,
  writeTexts,
  type TextIndex,
} from "./catalog-texts";
import { refreshCategoryCompleteness } from "./completeness";
import { countSameProductItems } from "./same-products";
import {
  attribute,
  attributeOption,
  category,
  type AttributeOptionRow,
  type AttributeRow,
  type CategoryRow,
  type TranslationEntityType,
} from "./schema";

/** Who changes the catalog: an administrator (API) or the operator command (the dev seed). */
export type CatalogActor = Extract<AuditActorRecord, { role: "admin" } | { role: "operator" }>;

type Names = Record<CatalogLanguage, string | null>;

const NO_TEXTS: Names = { kk: null, ru: null, en: null };

/**
 * Every change of the catalog structure takes this one transaction lock
 * (exclusively; changes of items take it shared — catalog-locks.ts):
 * changes are rare (an administrator at a screen), and with them
 * serialized the checks that span rows — two levels, unique names among
 * neighbours, the full list of siblings to reorder — can't race.
 */
const CATALOG_LOCK = STRUCTURE_LOCK;

function iso(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

function numberOf(value: string | null): number | null {
  return value === null ? null : Number(value);
}

function sameSiblings(current: readonly string[], wanted: readonly string[]): boolean {
  return (
    current.length === wanted.length &&
    new Set(wanted).size === wanted.length &&
    wanted.every((id) => current.includes(id))
  );
}

function sameSequence(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * Whether a new order of siblings is written (TASK-010.A): it must name
 * every sibling once (`CATALOG_ORDER_MISMATCH`); the order already stored
 * changes nothing and isn't journaled — a repeated request or someone
 * else having put them the same way; an order made from another one than
 * stored (`expectedOrder`) is refused rather than written over it.
 */
function orderChange(
  current: readonly string[],
  wanted: readonly string[],
  expected: readonly string[] | undefined,
): boolean {
  if (!sameSiblings(current, wanted)) {
    throw orderMismatch();
  }
  if (sameSequence(current, wanted)) {
    return false;
  }
  if (expected !== undefined && !sameSequence(current, expected)) {
    throw orderConflict(current);
  }
  return true;
}

/**
 * The catalog structure for the administrator (ARCHITECTURE 4.15; TASK-010;
 * SCREENS A-CAT-01, A-CAT-02): categories, attributes and list options —
 * create, change, reorder, hide/archive/restore. Nothing is ever deleted.
 * Every change is one transaction with its entry in the action journal,
 * and one made from an older version than the current one is refused
 * (`CATALOG_VERSION_CONFLICT`) rather than overwriting someone else's.
 */
@Injectable()
export class CatalogAdminService {
  private readonly logger = new Logger("Catalog");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditLog) private readonly audit: AuditLog,
  ) {}

  // ---------------------------------------------------------------- reads

  async tree(executor: DbExecutor = this.database.db): Promise<AdminCategoryTreeResponse> {
    const rows = await executor
      .select()
      .from(category)
      .orderBy(asc(category.kind), asc(category.sort), asc(category.code));
    const texts = await loadTexts(
      executor,
      "category",
      rows.map((row) => row.id),
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    const roots = rows.filter((row) => row.level === 1);
    return {
      categories: roots.map((root) => ({
        ...this.describeCategory(root, texts, undefined),
        children: rows
          .filter((row) => row.parentId === root.id)
          .map((child) => this.describeCategory(child, texts, byId.get(root.id))),
      })),
    };
  }

  async attributes(
    categoryId: string,
    executor: DbExecutor = this.database.db,
  ): Promise<AdminAttributeListResponse> {
    const row = await this.findCategory(executor, categoryId);
    const [described, attributes] = await Promise.all([
      this.describeCategoryById(executor, row),
      this.describeAttributesOf(executor, row.id),
    ]);
    return { category: described, attributes };
  }

  /** Ids by code, for the development seed (ARCHITECTURE 4.15). */
  async findCategoryByCode(code: string): Promise<CategoryRow | undefined> {
    const [row] = await this.database.db.select().from(category).where(eq(category.code, code));
    return row;
  }

  async findAttributeByCode(categoryId: string, code: string): Promise<AttributeRow | undefined> {
    const [row] = await this.database.db
      .select()
      .from(attribute)
      .where(and(eq(attribute.categoryId, categoryId), eq(attribute.code, code)));
    return row;
  }

  async findOptionByCode(
    attributeId: string,
    code: string,
  ): Promise<AttributeOptionRow | undefined> {
    const [row] = await this.database.db
      .select()
      .from(attributeOption)
      .where(and(eq(attributeOption.attributeId, attributeId), eq(attributeOption.code, code)));
    return row;
  }

  // ----------------------------------------------------------- categories

  async createCategory(input: CreateCategoryBody, actor: CatalogActor): Promise<AdminCategory> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(CATALOG_LOCK);
      if (await this.codeUsed(tx, input.code)) {
        throw codeTaken();
      }
      const parentId = input.parentId ?? null;
      const parent = parentId ? await this.parentFor(tx, parentId, input.kind) : undefined;
      const level = parent ? 2 : 1;
      const compatibilityRequired = input.compatibilityRequired ?? false;
      this.checkCompatibility(compatibilityRequired, input.kind, level);
      const names = mergeTexts(NO_TEXTS, input.names);
      const siblings = await this.siblingsOf(tx, parentId, input.kind);
      await this.assertNamesFree(tx, "category", siblings, names, undefined);

      const [row] = await tx
        .insert(category)
        .values({
          code: input.code,
          kind: input.kind,
          level,
          parentId,
          parentLevel: parent ? 1 : null,
          sort: this.nextSort(siblings),
          icon: input.icon ?? null,
          compatibilityRequired,
        })
        .returning();
      const created = row!;
      await writeTexts(tx, "category", created.id, "name", {}, names);
      const described = await this.describeCategoryById(tx, created);
      await this.audit.record(
        {
          action: auditActions.catalogCategoryCreated,
          actor,
          entityType: auditEntities.catalogCategory,
          entityId: created.id,
          after: this.categoryJournal(described),
        },
        tx,
      );
      this.logger.log(`Category created category=${created.id} code=${created.code}`);
      return described;
    });
  }

  async updateCategory(
    categoryId: string,
    input: UpdateCategoryBody,
    actor: CatalogActor,
  ): Promise<AdminCategory> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(CATALOG_LOCK);
      const row = await this.findCategory(tx, categoryId);
      if (row.version !== input.expectedVersion) {
        throw versionConflict(row.version);
      }
      if (input.kind !== undefined && input.kind !== row.kind) {
        throw kindMismatch();
      }

      let parentId = row.parentId;
      let sort = row.sort;
      if (input.parentId !== undefined && input.parentId !== row.parentId) {
        if (row.level === 1 || input.parentId === null) {
          throw levelImmutable();
        }
        await this.parentFor(tx, input.parentId, row.kind);
        parentId = input.parentId;
        sort = this.nextSort(await this.siblingsOf(tx, parentId, row.kind));
      }
      const compatibilityRequired = input.compatibilityRequired ?? row.compatibilityRequired;
      this.checkCompatibility(compatibilityRequired, row.kind, row.level);

      const texts = await loadTexts(tx, "category", [row.id]);
      const currentTexts = textsOf(texts, row.id, "name");
      const before = plainTexts(currentTexts);
      const names = mergeTexts(before, input.names);
      if (row.status !== "archived") {
        const siblings = await this.siblingsOf(tx, parentId, row.kind);
        await this.assertNamesFree(tx, "category", siblings, names, row.id);
      }
      const icon = input.icon === undefined ? row.icon : input.icon;

      const changedBefore: Record<string, unknown> = {};
      const changedAfter: Record<string, unknown> = {};
      const note = (field: string, was: unknown, now: unknown) => {
        if (JSON.stringify(was) !== JSON.stringify(now)) {
          changedBefore[field] = was;
          changedAfter[field] = now;
        }
      };
      note("names", before, names);
      note("icon", row.icon, icon);
      note("compatibilityRequired", row.compatibilityRequired, compatibilityRequired);
      note("parentId", row.parentId, parentId);
      if (Object.keys(changedAfter).length === 0) {
        return this.describeCategoryById(tx, row);
      }

      const [updated] = await tx
        .update(category)
        .set({
          parentId,
          sort,
          icon,
          compatibilityRequired,
          version: row.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(category.id, row.id))
        .returning();
      await writeTexts(tx, "category", row.id, "name", currentTexts, names);
      await this.audit.record(
        {
          action: auditActions.catalogCategoryChanged,
          actor,
          entityType: auditEntities.catalogCategory,
          entityId: row.id,
          before: changedBefore,
          after: { ...changedAfter, version: updated!.version },
        },
        tx,
      );
      this.logger.log(
        `Category changed category=${row.id} fields=${Object.keys(changedAfter).join(",")} version=${updated!.version}`,
      );
      return this.describeCategoryById(tx, updated!);
    });
  }

  async setCategoryStatus(
    categoryId: string,
    status: CategoryStatus,
    expectedVersion: number,
    actor: CatalogActor,
  ): Promise<AdminCategory> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(CATALOG_LOCK);
      const row = await this.findCategory(tx, categoryId);
      if (row.version !== expectedVersion) {
        throw versionConflict(row.version);
      }
      if (row.status === status) {
        return this.describeCategoryById(tx, row);
      }
      if (status !== "archived") {
        if (row.parentId) {
          const parent = await this.findCategory(tx, row.parentId);
          if (parent.status === "archived") {
            throw parentArchived();
          }
        }
        if (row.status === "archived") {
          // Back from the archive: its name must still be free among the neighbours.
          const texts = await loadTexts(tx, "category", [row.id]);
          const siblings = await this.siblingsOf(tx, row.parentId, row.kind);
          await this.assertNamesFree(
            tx,
            "category",
            siblings,
            plainTexts(textsOf(texts, row.id, "name")),
            row.id,
          );
        }
      }
      const [updated] = await tx
        .update(category)
        .set({
          status,
          archivedAt: status === "archived" ? new Date() : null,
          version: row.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(category.id, row.id))
        .returning();
      await this.audit.record(
        {
          action: auditActions.catalogCategoryStatusChanged,
          actor,
          entityType: auditEntities.catalogCategory,
          entityId: row.id,
          before: { status: row.status },
          after: { status, version: updated!.version },
        },
        tx,
      );
      this.logger.log(`Category status category=${row.id} from=${row.status} to=${status}`);
      return this.describeCategoryById(tx, updated!);
    });
  }

  async reorderCategories(
    parentId: string | null,
    kind: CategoryKind,
    categoryIds: readonly string[],
    expectedOrder: readonly string[] | undefined,
    actor: CatalogActor,
  ): Promise<AdminCategoryTreeResponse> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(CATALOG_LOCK);
      if (parentId) {
        const parent = await this.findCategory(tx, parentId);
        if (parent.kind !== kind) {
          throw kindMismatch();
        }
      }
      const siblings = await this.siblingsOf(tx, parentId, kind);
      const current = siblings.map((row) => row.id);
      if (!orderChange(current, categoryIds, expectedOrder)) {
        return this.tree(tx);
      }
      await this.applyOrder(tx, category, categoryIds);
      await this.audit.record(
        {
          action: auditActions.catalogCategoriesReordered,
          actor,
          entityType: auditEntities.catalogCategory,
          entityId: parentId ?? kind,
          before: { order: current },
          after: { order: categoryIds },
        },
        tx,
      );
      return this.tree(tx);
    });
  }

  // ----------------------------------------------------------- attributes

  async createAttribute(
    categoryId: string,
    input: CreateAttributeBody,
    actor: CatalogActor,
  ): Promise<AdminAttribute> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(CATALOG_LOCK);
      const owner = await this.findCategory(tx, categoryId);
      if (owner.level !== 2) {
        throw notSubcategory();
      }
      const valueType = input.valueType;
      const isNumber = valueType === "number";
      if (isNumber && !input.number) {
        throw validationError("number", "A number attribute needs its settings");
      }
      if (!isNumber && input.number) {
        throw validationError("number", "Only a number attribute has number settings");
      }
      if (!isNumber && input.unit) {
        throw validationError("unit", "Only a number attribute has a unit");
      }
      if (valueType !== "enum" && input.options && input.options.length > 0) {
        throw validationError("options", "Only a list attribute has options");
      }
      const isFilterable = input.isFilterable ?? false;
      if (valueType === "text" && isFilterable) {
        throw validationError("isFilterable", "A text attribute can't be a filter");
      }
      if (input.number) {
        this.checkNumber(input.number);
      }
      const [taken] = await tx
        .select({ id: attribute.id })
        .from(attribute)
        .where(and(eq(attribute.categoryId, owner.id), eq(attribute.code, input.code)));
      if (taken) {
        throw codeTaken();
      }
      const siblings = await this.attributeRowsOf(tx, owner.id);
      const names = mergeTexts(NO_TEXTS, input.names);
      await this.assertNamesFree(tx, "attribute", siblings, names, undefined);
      const options = input.options ?? [];
      this.checkNewOptions(options);

      const [row] = await tx
        .insert(attribute)
        .values({
          categoryId: owner.id,
          code: input.code,
          valueType,
          numberInteger: input.number ? input.number.integer : null,
          numberMin: input.number?.min == null ? null : String(input.number.min),
          numberMax: input.number?.max == null ? null : String(input.number.max),
          isFilterable,
          isRequiredForComplete: input.isRequiredForComplete ?? false,
          sort: this.nextSort(siblings),
        })
        .returning();
      const created = row!;
      await writeTexts(tx, "attribute", created.id, "name", {}, names);
      if (input.unit) {
        await writeTexts(tx, "attribute", created.id, "unit", {}, mergeTexts(NO_TEXTS, input.unit));
      }
      for (const [index, option] of options.entries()) {
        const [optionRow] = await tx
          .insert(attributeOption)
          .values({ attributeId: created.id, code: option.code, sort: index })
          .returning();
        await writeTexts(
          tx,
          "attribute_option",
          optionRow!.id,
          "name",
          {},
          mergeTexts(NO_TEXTS, option.names),
        );
      }
      if (created.isRequiredForComplete) {
        await refreshCategoryCompleteness(tx, owner.id);
      }
      const described = await this.describeAttribute(tx, created);
      await this.audit.record(
        {
          action: auditActions.catalogAttributeCreated,
          actor,
          entityType: auditEntities.catalogAttribute,
          entityId: created.id,
          after: this.attributeJournal(described),
        },
        tx,
      );
      this.logger.log(
        `Attribute created attribute=${created.id} category=${owner.id} code=${created.code} type=${valueType}`,
      );
      return described;
    });
  }

  async updateAttribute(
    attributeId: string,
    input: UpdateAttributeBody,
    actor: CatalogActor,
  ): Promise<AdminAttribute> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(CATALOG_LOCK);
      const row = await this.findAttribute(tx, attributeId);
      if (row.version !== input.expectedVersion) {
        throw versionConflict(row.version);
      }
      if (input.valueType !== undefined && input.valueType !== row.valueType) {
        throw attributeTypeImmutable();
      }
      const isNumber = row.valueType === "number";
      if (!isNumber && input.number) {
        throw validationError("number", "Only a number attribute has number settings");
      }
      if (!isNumber && input.unit) {
        throw validationError("unit", "Only a number attribute has a unit");
      }
      const isFilterable = input.isFilterable ?? row.isFilterable;
      if (row.valueType === "text" && isFilterable) {
        throw validationError("isFilterable", "A text attribute can't be a filter");
      }
      if (input.number) {
        this.checkNumber(input.number);
      }
      const texts = await loadTexts(tx, "attribute", [row.id]);
      const currentNames = textsOf(texts, row.id, "name");
      const currentUnit = textsOf(texts, row.id, "unit");
      const namesBefore = plainTexts(currentNames);
      const names = mergeTexts(namesBefore, input.names);
      const unitBefore = plainTexts(currentUnit);
      const unit = input.unit === null ? NO_TEXTS : mergeTexts(unitBefore, input.unit);
      if (unit.ru === null && (unit.kk !== null || unit.en !== null)) {
        throw validationError("unit.ru", "A unit needs its Russian text");
      }
      if (row.status !== "archived") {
        const siblings = await this.attributeRowsOf(tx, row.categoryId);
        await this.assertNamesFree(tx, "attribute", siblings, names, row.id);
      }

      const numberBefore = this.numberOf(row);
      const numberAfter = input.number ?? numberBefore;
      const changedBefore: Record<string, unknown> = {};
      const changedAfter: Record<string, unknown> = {};
      const note = (field: string, was: unknown, now: unknown) => {
        if (JSON.stringify(was) !== JSON.stringify(now)) {
          changedBefore[field] = was;
          changedAfter[field] = now;
        }
      };
      note("names", namesBefore, names);
      note("unit", unitBefore, unit);
      note("number", numberBefore, numberAfter);
      note("isFilterable", row.isFilterable, isFilterable);
      const isRequiredForComplete = input.isRequiredForComplete ?? row.isRequiredForComplete;
      note("isRequiredForComplete", row.isRequiredForComplete, isRequiredForComplete);
      if (Object.keys(changedAfter).length === 0) {
        return this.describeAttribute(tx, row);
      }

      const [updated] = await tx
        .update(attribute)
        .set({
          ...(numberAfter && {
            numberInteger: numberAfter.integer,
            numberMin: numberAfter.min === null ? null : String(numberAfter.min),
            numberMax: numberAfter.max === null ? null : String(numberAfter.max),
          }),
          isFilterable,
          isRequiredForComplete,
          version: row.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(attribute.id, row.id))
        .returning();
      await writeTexts(tx, "attribute", row.id, "name", currentNames, names);
      await writeTexts(tx, "attribute", row.id, "unit", currentUnit, unit);
      if (isRequiredForComplete !== row.isRequiredForComplete) {
        await refreshCategoryCompleteness(tx, row.categoryId);
      }
      await this.audit.record(
        {
          action: auditActions.catalogAttributeChanged,
          actor,
          entityType: auditEntities.catalogAttribute,
          entityId: row.id,
          before: changedBefore,
          after: { ...changedAfter, version: updated!.version },
        },
        tx,
      );
      this.logger.log(
        `Attribute changed attribute=${row.id} fields=${Object.keys(changedAfter).join(",")} version=${updated!.version}`,
      );
      return this.describeAttribute(tx, updated!);
    });
  }

  async setAttributeStatus(
    attributeId: string,
    status: CatalogEntryStatus,
    expectedVersion: number,
    actor: CatalogActor,
  ): Promise<AdminAttribute> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(CATALOG_LOCK);
      const row = await this.findAttribute(tx, attributeId);
      if (row.version !== expectedVersion) {
        throw versionConflict(row.version);
      }
      if (row.status === status) {
        return this.describeAttribute(tx, row);
      }
      if (status === "active") {
        const texts = await loadTexts(tx, "attribute", [row.id]);
        await this.assertNamesFree(
          tx,
          "attribute",
          await this.attributeRowsOf(tx, row.categoryId),
          plainTexts(textsOf(texts, row.id, "name")),
          row.id,
        );
      }
      const [updated] = await tx
        .update(attribute)
        .set({
          status,
          archivedAt: status === "archived" ? new Date() : null,
          version: row.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(attribute.id, row.id))
        .returning();
      if (row.isRequiredForComplete) {
        await refreshCategoryCompleteness(tx, row.categoryId);
      }
      await this.audit.record(
        {
          action: auditActions.catalogAttributeStatusChanged,
          actor,
          entityType: auditEntities.catalogAttribute,
          entityId: row.id,
          before: { status: row.status },
          after: { status, version: updated!.version },
        },
        tx,
      );
      this.logger.log(`Attribute status attribute=${row.id} from=${row.status} to=${status}`);
      return this.describeAttribute(tx, updated!);
    });
  }

  async reorderAttributes(
    categoryId: string,
    attributeIds: readonly string[],
    expectedOrder: readonly string[] | undefined,
    actor: CatalogActor,
  ): Promise<AdminAttributeListResponse> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(CATALOG_LOCK);
      const owner = await this.findCategory(tx, categoryId);
      const current = (await this.attributeRowsOf(tx, owner.id)).map((row) => row.id);
      if (!orderChange(current, attributeIds, expectedOrder)) {
        return this.attributes(owner.id, tx);
      }
      await this.applyOrder(tx, attribute, attributeIds);
      await this.audit.record(
        {
          action: auditActions.catalogAttributesReordered,
          actor,
          entityType: auditEntities.catalogCategory,
          entityId: owner.id,
          before: { order: current },
          after: { order: attributeIds },
        },
        tx,
      );
      return this.attributes(owner.id, tx);
    });
  }

  // --------------------------------------------------------- list options

  async createOption(
    attributeId: string,
    input: CreateAttributeOptionBody,
    actor: CatalogActor,
  ): Promise<AdminAttributeOption> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(CATALOG_LOCK);
      const owner = await this.findAttribute(tx, attributeId);
      if (owner.valueType !== "enum") {
        throw validationError("attributeId", "Only a list attribute has options");
      }
      const siblings = await this.optionRowsOf(tx, owner.id);
      if (siblings.some((row) => row.code === input.code)) {
        throw codeTaken();
      }
      const names = mergeTexts(NO_TEXTS, input.names);
      await this.assertNamesFree(tx, "attribute_option", siblings, names, undefined);
      const [row] = await tx
        .insert(attributeOption)
        .values({ attributeId: owner.id, code: input.code, sort: this.nextSort(siblings) })
        .returning();
      const created = row!;
      await writeTexts(tx, "attribute_option", created.id, "name", {}, names);
      const described = await this.describeOption(tx, created);
      await this.audit.record(
        {
          action: auditActions.catalogAttributeOptionCreated,
          actor,
          entityType: auditEntities.catalogAttributeOption,
          entityId: created.id,
          after: { attributeId: owner.id, code: created.code, names, sort: created.sort },
        },
        tx,
      );
      this.logger.log(`Attribute option created option=${created.id} attribute=${owner.id}`);
      return described;
    });
  }

  async updateOption(
    optionId: string,
    input: UpdateAttributeOptionBody,
    actor: CatalogActor,
  ): Promise<AdminAttributeOption> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(CATALOG_LOCK);
      const row = await this.findOption(tx, optionId);
      if (row.version !== input.expectedVersion) {
        throw versionConflict(row.version);
      }
      const texts = await loadTexts(tx, "attribute_option", [row.id]);
      const current = textsOf(texts, row.id, "name");
      const before = plainTexts(current);
      const names = mergeTexts(before, input.names);
      if (JSON.stringify(before) === JSON.stringify(names)) {
        return this.describeOption(tx, row);
      }
      if (row.status !== "archived") {
        await this.assertNamesFree(
          tx,
          "attribute_option",
          await this.optionRowsOf(tx, row.attributeId),
          names,
          row.id,
        );
      }
      const [updated] = await tx
        .update(attributeOption)
        .set({ version: row.version + 1, updatedAt: new Date() })
        .where(eq(attributeOption.id, row.id))
        .returning();
      await writeTexts(tx, "attribute_option", row.id, "name", current, names);
      await this.audit.record(
        {
          action: auditActions.catalogAttributeOptionChanged,
          actor,
          entityType: auditEntities.catalogAttributeOption,
          entityId: row.id,
          before: { names: before },
          after: { names, version: updated!.version },
        },
        tx,
      );
      return this.describeOption(tx, updated!);
    });
  }

  async setOptionStatus(
    optionId: string,
    status: CatalogEntryStatus,
    expectedVersion: number,
    actor: CatalogActor,
  ): Promise<AdminAttributeOption> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(CATALOG_LOCK);
      const row = await this.findOption(tx, optionId);
      if (row.version !== expectedVersion) {
        throw versionConflict(row.version);
      }
      if (row.status === status) {
        return this.describeOption(tx, row);
      }
      if (status === "active") {
        const texts = await loadTexts(tx, "attribute_option", [row.id]);
        await this.assertNamesFree(
          tx,
          "attribute_option",
          await this.optionRowsOf(tx, row.attributeId),
          plainTexts(textsOf(texts, row.id, "name")),
          row.id,
        );
      }
      const [updated] = await tx
        .update(attributeOption)
        .set({
          status,
          archivedAt: status === "archived" ? new Date() : null,
          version: row.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(attributeOption.id, row.id))
        .returning();
      await this.audit.record(
        {
          action: auditActions.catalogAttributeOptionStatusChanged,
          actor,
          entityType: auditEntities.catalogAttributeOption,
          entityId: row.id,
          before: { status: row.status },
          after: { status, version: updated!.version },
        },
        tx,
      );
      this.logger.log(`Attribute option status option=${row.id} from=${row.status} to=${status}`);
      return this.describeOption(tx, updated!);
    });
  }

  async reorderOptions(
    attributeId: string,
    optionIds: readonly string[],
    expectedOrder: readonly string[] | undefined,
    actor: CatalogActor,
  ): Promise<AdminAttribute> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(CATALOG_LOCK);
      const owner = await this.findAttribute(tx, attributeId);
      const current = (await this.optionRowsOf(tx, owner.id)).map((row) => row.id);
      if (!orderChange(current, optionIds, expectedOrder)) {
        return this.describeAttribute(tx, owner);
      }
      await this.applyOrder(tx, attributeOption, optionIds);
      await this.audit.record(
        {
          action: auditActions.catalogAttributeOptionsReordered,
          actor,
          entityType: auditEntities.catalogAttribute,
          entityId: owner.id,
          before: { order: current },
          after: { order: optionIds },
        },
        tx,
      );
      return this.describeAttribute(tx, owner);
    });
  }

  /**
   * Items of the attribute's category (every status) without a value of it
   * (SCREENS A-CAT-02 «У N позиций значение будет пустым»).
   */
  async itemsWithoutValue(
    row: Pick<AdminAttribute, "id" | "categoryId">,
    executor: DbExecutor = this.database.db,
  ): Promise<number> {
    const result = await executor.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM catalog_item i
      WHERE i.category_id = ${row.categoryId}
        AND NOT EXISTS (
          SELECT 1 FROM item_attribute_value v WHERE v.item_id = i.id AND v.attribute_id = ${row.id}
        )`);
    return Number(result.rows[0]?.count ?? 0);
  }

  /** Products of the category that are the same as another one (TASK-011.A). */
  sameProductItems(categoryId: string, executor: DbExecutor = this.database.db): Promise<number> {
    return countSameProductItems(executor, categoryId);
  }

  // -------------------------------------------------------------- helpers

  private async findCategory(executor: DbExecutor, id: string): Promise<CategoryRow> {
    const [row] = await executor.select().from(category).where(eq(category.id, id));
    if (!row) {
      throw notFound("category");
    }
    return row;
  }

  private async findAttribute(executor: DbExecutor, id: string): Promise<AttributeRow> {
    const [row] = await executor.select().from(attribute).where(eq(attribute.id, id));
    if (!row) {
      throw notFound("attribute");
    }
    return row;
  }

  private async findOption(executor: DbExecutor, id: string): Promise<AttributeOptionRow> {
    const [row] = await executor.select().from(attributeOption).where(eq(attributeOption.id, id));
    if (!row) {
      throw notFound("attribute option");
    }
    return row;
  }

  private async codeUsed(executor: DbExecutor, code: string): Promise<boolean> {
    const [row] = await executor
      .select({ id: category.id })
      .from(category)
      .where(eq(category.code, code));
    return row !== undefined;
  }

  /** The node a subcategory of `kind` may go under (the checks of AC-1 before the database's). */
  private async parentFor(
    executor: DbExecutor,
    parentId: string,
    kind: CategoryKind,
  ): Promise<CategoryRow> {
    const [parent] = await executor.select().from(category).where(eq(category.id, parentId));
    if (!parent) {
      throw notFound("parent category");
    }
    if (parent.level !== 1) {
      throw depthExceeded();
    }
    if (parent.kind !== kind) {
      throw kindMismatch();
    }
    if (parent.status === "archived") {
      throw parentArchived();
    }
    return parent;
  }

  private checkCompatibility(required: boolean, kind: CategoryKind, level: number): void {
    if (required && (kind !== "goods" || level !== 2)) {
      throw validationError(
        "compatibilityRequired",
        "Only a subcategory of goods can require compatibility",
      );
    }
  }

  private checkNumber(number: NumberSettings): void {
    if (number.min !== null && number.max !== null && number.min > number.max) {
      throw validationError("number.min", "The lower bound is above the upper one");
    }
    if (number.integer) {
      for (const [path, value] of [
        ["number.min", number.min],
        ["number.max", number.max],
      ] as const) {
        if (value !== null && !Number.isInteger(value)) {
          throw validationError(path, "A whole-number attribute has whole bounds");
        }
      }
    }
  }

  private checkNewOptions(options: CreateAttributeBody["options"] & object): void {
    const codes = new Set<string>();
    const names = new Map<string, Set<string>>();
    for (const [index, option] of options.entries()) {
      if (codes.has(option.code)) {
        throw validationError(`options.${index}.code`, "Option codes repeat");
      }
      codes.add(option.code);
      for (const { lang, text } of languagesOf(mergeTexts(NO_TEXTS, option.names))) {
        const seen = names.get(lang) ?? new Set<string>();
        if (seen.has(nameKey(text))) {
          throw validationError(`options.${index}.names.${lang}`, "Option names repeat");
        }
        seen.add(nameKey(text));
        names.set(lang, seen);
      }
    }
  }

  private siblingsOf(
    executor: DbExecutor,
    parentId: string | null,
    kind: CategoryKind,
  ): Promise<CategoryRow[]> {
    return executor
      .select()
      .from(category)
      .where(
        parentId
          ? eq(category.parentId, parentId)
          : and(isNull(category.parentId), eq(category.kind, kind)),
      )
      .orderBy(asc(category.sort), asc(category.code));
  }

  private attributeRowsOf(executor: DbExecutor, categoryId: string): Promise<AttributeRow[]> {
    return executor
      .select()
      .from(attribute)
      .where(eq(attribute.categoryId, categoryId))
      .orderBy(asc(attribute.sort), asc(attribute.code));
  }

  private optionRowsOf(executor: DbExecutor, attributeId: string): Promise<AttributeOptionRow[]> {
    return executor
      .select()
      .from(attributeOption)
      .where(eq(attributeOption.attributeId, attributeId))
      .orderBy(asc(attributeOption.sort), asc(attributeOption.code));
  }

  private nextSort(siblings: readonly { sort: number }[]): number {
    return siblings.reduce((highest, row) => Math.max(highest, row.sort + 1), 0);
  }

  private async applyOrder(
    executor: DbExecutor,
    table: typeof category | typeof attribute | typeof attributeOption,
    ids: readonly string[],
  ): Promise<void> {
    for (const [index, id] of ids.entries()) {
      await executor.update(table).set({ sort: index }).where(eq(table.id, id));
    }
  }

  /**
   * No other non-archived neighbour has any of these names, whatever the
   * case (edge case «Колодки» / «колодки»). Archived neighbours don't
   * count — a name is checked again when one comes back from the archive.
   */
  private async assertNamesFree(
    executor: DbExecutor,
    entityType: TranslationEntityType,
    siblings: readonly { id: string; status: string }[],
    names: Names,
    selfId: string | undefined,
  ): Promise<void> {
    const others = siblings.filter((row) => row.id !== selfId && row.status !== "archived");
    if (others.length === 0) {
      return;
    }
    const texts = await loadTexts(
      executor,
      entityType,
      others.map((row) => row.id),
    );
    for (const { lang, text } of languagesOf(names)) {
      const key = nameKey(text);
      const clash = others.find((row) => {
        const other = textsOf(texts, row.id, "name")[lang];
        return other !== undefined && nameKey(other.text) === key;
      });
      if (clash) {
        throw nameTaken(lang, clash.id);
      }
    }
  }

  private numberOf(row: AttributeRow): NumberSettings | null {
    return row.valueType === "number"
      ? {
          integer: row.numberInteger ?? false,
          min: numberOf(row.numberMin),
          max: numberOf(row.numberMax),
        }
      : null;
  }

  private describeCategory(
    row: CategoryRow,
    texts: TextIndex,
    parent: CategoryRow | undefined,
  ): AdminCategory {
    return {
      id: row.id,
      code: row.code,
      kind: row.kind,
      level: row.level,
      parentId: row.parentId,
      names: describeTexts(textsOf(texts, row.id, "name")),
      icon: row.icon as CategoryIcon | null,
      sort: row.sort,
      status: row.status,
      visibleToClients: row.status === "active" && (!parent || parent.status === "active"),
      compatibilityRequired: row.compatibilityRequired,
      version: row.version,
      archivedAt: iso(row.archivedAt),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async describeCategoryById(
    executor: DbExecutor,
    row: CategoryRow,
  ): Promise<AdminCategory> {
    const [texts, parent] = await Promise.all([
      loadTexts(executor, "category", [row.id]),
      row.parentId ? this.findCategory(executor, row.parentId) : Promise.resolve(undefined),
    ]);
    return this.describeCategory(row, texts, parent);
  }

  private async describeAttributesOf(
    executor: DbExecutor,
    categoryId: string,
  ): Promise<AdminAttribute[]> {
    const rows = await this.attributeRowsOf(executor, categoryId);
    const options =
      rows.length === 0
        ? []
        : await executor
            .select()
            .from(attributeOption)
            .where(
              inArray(
                attributeOption.attributeId,
                rows.map((row) => row.id),
              ),
            )
            .orderBy(asc(attributeOption.sort), asc(attributeOption.code));
    const [attributeTexts, optionTexts] = await Promise.all([
      loadTexts(
        executor,
        "attribute",
        rows.map((row) => row.id),
      ),
      loadTexts(
        executor,
        "attribute_option",
        options.map((row) => row.id),
      ),
    ]);
    return rows.map((row) =>
      this.toAdminAttribute(
        row,
        attributeTexts,
        options.filter((option) => option.attributeId === row.id),
        optionTexts,
      ),
    );
  }

  private async describeAttribute(
    executor: DbExecutor,
    row: AttributeRow,
  ): Promise<AdminAttribute> {
    const options = await this.optionRowsOf(executor, row.id);
    const [attributeTexts, optionTexts] = await Promise.all([
      loadTexts(executor, "attribute", [row.id]),
      loadTexts(
        executor,
        "attribute_option",
        options.map((option) => option.id),
      ),
    ]);
    return this.toAdminAttribute(row, attributeTexts, options, optionTexts);
  }

  private toAdminAttribute(
    row: AttributeRow,
    texts: TextIndex,
    options: readonly AttributeOptionRow[],
    optionTexts: TextIndex,
  ): AdminAttribute {
    const unit = textsOf(texts, row.id, "unit");
    return {
      id: row.id,
      categoryId: row.categoryId,
      code: row.code,
      valueType: row.valueType,
      names: describeTexts(textsOf(texts, row.id, "name")),
      unit: row.valueType === "number" && unit.ru ? describeTexts(unit) : null,
      number: this.numberOf(row),
      isFilterable: row.isFilterable,
      isRequiredForComplete: row.isRequiredForComplete,
      sort: row.sort,
      status: row.status,
      version: row.version,
      archivedAt: iso(row.archivedAt),
      updatedAt: row.updatedAt.toISOString(),
      options: options.map((option) => this.toAdminOption(option, optionTexts)),
    };
  }

  private toAdminOption(row: AttributeOptionRow, texts: TextIndex): AdminAttributeOption {
    return {
      id: row.id,
      attributeId: row.attributeId,
      code: row.code,
      names: describeTexts(textsOf(texts, row.id, "name")),
      sort: row.sort,
      status: row.status,
      version: row.version,
      archivedAt: iso(row.archivedAt),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async describeOption(
    executor: DbExecutor,
    row: AttributeOptionRow,
  ): Promise<AdminAttributeOption> {
    return this.toAdminOption(row, await loadTexts(executor, "attribute_option", [row.id]));
  }

  /** What the journal keeps of a new category: the fields, names as plain text. */
  private categoryJournal(described: AdminCategory): Record<string, unknown> {
    return {
      code: described.code,
      kind: described.kind,
      level: described.level,
      parentId: described.parentId,
      names: {
        kk: described.names.kk?.text ?? null,
        ru: described.names.ru?.text ?? null,
        en: described.names.en?.text ?? null,
      },
      icon: described.icon,
      compatibilityRequired: described.compatibilityRequired,
      status: described.status,
      sort: described.sort,
    };
  }

  private attributeJournal(described: AdminAttribute): Record<string, unknown> {
    const plain = (texts: AdminAttribute["names"] | null) =>
      texts
        ? { kk: texts.kk?.text ?? null, ru: texts.ru?.text ?? null, en: texts.en?.text ?? null }
        : null;
    return {
      categoryId: described.categoryId,
      code: described.code,
      valueType: described.valueType,
      names: plain(described.names),
      unit: plain(described.unit),
      number: described.number,
      isFilterable: described.isFilterable,
      isRequiredForComplete: described.isRequiredForComplete,
      sort: described.sort,
      options: described.options.map((option) => ({
        id: option.id,
        code: option.code,
        names: plain(option.names),
      })),
    };
  }
}
