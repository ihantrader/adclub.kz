import type { CatalogLanguage } from "@adclub/contracts";
import { and, eq, isNull } from "drizzle-orm";
import type { DbExecutor } from "../../database";
import { languagesOf, loadTexts, nameKey, textsOf } from "./catalog-texts";
import {
  attribute,
  attributeOption,
  catalogItem,
  category,
  type TranslationEntityType,
} from "./schema";

/**
 * Uniqueness of names among neighbours (ARCHITECTURE 4.15 I144), in one
 * place for everyone who writes a name: the administrator (categories,
 * attributes, options) and automatic translation (TASK-012) — a
 * translation never gets past what a person would be refused.
 */

export interface NameNeighbour {
  id: string;
  status: string;
}

/**
 * No other non-archived neighbour has any of these names, whatever the
 * case (edge case «Колодки» / «колодки»). Archived neighbours don't
 * count — a name is checked again when one comes back from the archive.
 * Returns the first clash, `undefined` when the names are free.
 */
export async function findNameClash(
  executor: DbExecutor,
  entityType: TranslationEntityType,
  siblings: readonly NameNeighbour[],
  names: Record<CatalogLanguage, string | null>,
  selfId: string | undefined,
): Promise<{ lang: CatalogLanguage; id: string } | undefined> {
  const others = siblings.filter((row) => row.id !== selfId && row.status !== "archived");
  if (others.length === 0) {
    return undefined;
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
      return { lang, id: clash.id };
    }
  }
  return undefined;
}

/**
 * The entity's status, everyone whose name it must differ from (`entity`
 * included) and what names that set of neighbours is — subcategories of
 * one node, nodes of one kind, attributes of one category, options of one
 * attribute. `scope` names that set, so a writer can take a lock on just
 * it (`nameScopeLock`, ARCHITECTURE 4.20 I191). Items are neighbours of
 * nobody (an item is told apart by brand and article), so theirs is empty
 * and has no scope. `undefined` — no such entity.
 */
export async function nameNeighbours(
  executor: DbExecutor,
  entityType: TranslationEntityType,
  entityId: string,
): Promise<{ status: string; neighbours: NameNeighbour[]; scope: string | null } | undefined> {
  switch (entityType) {
    case "category": {
      const [self] = await executor.select().from(category).where(eq(category.id, entityId));
      if (!self) {
        return undefined;
      }
      const neighbours = await executor
        .select({ id: category.id, status: category.status })
        .from(category)
        .where(
          self.parentId
            ? eq(category.parentId, self.parentId)
            : and(isNull(category.parentId), eq(category.kind, self.kind)),
        );
      return {
        status: self.status,
        neighbours,
        scope: self.parentId ? `category:${self.parentId}` : `category:root:${self.kind}`,
      };
    }
    case "attribute": {
      const [self] = await executor.select().from(attribute).where(eq(attribute.id, entityId));
      if (!self) {
        return undefined;
      }
      const neighbours = await executor
        .select({ id: attribute.id, status: attribute.status })
        .from(attribute)
        .where(eq(attribute.categoryId, self.categoryId));
      return { status: self.status, neighbours, scope: `attribute:${self.categoryId}` };
    }
    case "attribute_option": {
      const [self] = await executor
        .select()
        .from(attributeOption)
        .where(eq(attributeOption.id, entityId));
      if (!self) {
        return undefined;
      }
      const neighbours = await executor
        .select({ id: attributeOption.id, status: attributeOption.status })
        .from(attributeOption)
        .where(eq(attributeOption.attributeId, self.attributeId));
      return {
        status: self.status,
        neighbours,
        scope: `attribute_option:${self.attributeId}`,
      };
    }
    case "catalog_item": {
      const [self] = await executor.select().from(catalogItem).where(eq(catalogItem.id, entityId));
      return self ? { status: self.status, neighbours: [], scope: null } : undefined;
    }
  }
}
