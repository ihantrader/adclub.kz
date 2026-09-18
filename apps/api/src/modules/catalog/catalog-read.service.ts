import { Inject, Injectable } from "@nestjs/common";
import type {
  CatalogLanguage,
  CategoryAttribute,
  CategoryAttributesResponse,
  CategoryIcon,
  CategorySubcategory,
  CategoryTreeResponse,
  LocalizedText,
} from "@adclub/contracts";
import { and, asc, eq, inArray } from "drizzle-orm";
import { DatabaseService } from "../../database";
import { notFound } from "./catalog-errors";
import { loadTexts, localize, textsOf, type TextIndex } from "./catalog-texts";
import { attribute, attributeOption, category, type CategoryRow } from "./schema";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A name that can't be missing: the admin checks always write Russian. */
function nameOf(texts: TextIndex, id: string, lang: CatalogLanguage): LocalizedText {
  return localize(textsOf(texts, id, "name"), lang) ?? { text: "", isFallback: true };
}

/**
 * The catalog structure for clients — the mobile app (guests included) and
 * the supplier cabinet (ARCHITECTURE 4.15; M-CAT-01, M-CAT-10, M-CAT-03):
 * only what is active, in the language of the request with the Russian
 * text as the fallback. Read from the database on every request; clients
 * and proxies may reuse an answer for `CATALOG_CLIENT_CACHE_SECONDS`.
 */
@Injectable()
export class CatalogReadService {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async tree(lang: CatalogLanguage): Promise<CategoryTreeResponse> {
    const rows = await this.database.db
      .select()
      .from(category)
      .where(eq(category.status, "active"))
      .orderBy(asc(category.kind), asc(category.sort), asc(category.code));
    const roots = rows.filter((row) => row.level === 1);
    const rootIds = new Set(roots.map((row) => row.id));
    // A subcategory is shown only under an active node (a hidden or
    // archived node hides its subcategories).
    const children = rows.filter((row) => row.parentId !== null && rootIds.has(row.parentId));
    const texts = await loadTexts(this.database.db, "category", [
      ...roots.map((row) => row.id),
      ...children.map((row) => row.id),
    ]);
    return {
      language: lang,
      categories: roots.map((root) => ({
        ...this.describe(root, texts, lang),
        children: children
          .filter((row) => row.parentId === root.id)
          .map((row) => this.describe(row, texts, lang)),
      })),
    };
  }

  async attributes(categoryId: string, lang: CatalogLanguage): Promise<CategoryAttributesResponse> {
    const row = await this.visibleCategory(categoryId);
    const attributes =
      row.level === 2
        ? await this.database.db
            .select()
            .from(attribute)
            .where(and(eq(attribute.categoryId, row.id), eq(attribute.status, "active")))
            .orderBy(asc(attribute.sort), asc(attribute.code))
        : [];
    const options =
      attributes.length === 0
        ? []
        : await this.database.db
            .select()
            .from(attributeOption)
            .where(
              and(
                inArray(
                  attributeOption.attributeId,
                  attributes.map((entry) => entry.id),
                ),
                eq(attributeOption.status, "active"),
              ),
            )
            .orderBy(asc(attributeOption.sort), asc(attributeOption.code));
    const [categoryTexts, attributeTexts, optionTexts] = await Promise.all([
      loadTexts(this.database.db, "category", [row.id]),
      loadTexts(
        this.database.db,
        "attribute",
        attributes.map((entry) => entry.id),
      ),
      loadTexts(
        this.database.db,
        "attribute_option",
        options.map((entry) => entry.id),
      ),
    ]);

    const described: CategoryAttribute[] = [];
    for (const entry of attributes) {
      const own = options.filter((option) => option.attributeId === entry.id);
      // A list with no active option can't be filled in or filtered by.
      if (entry.valueType === "enum" && own.length === 0) {
        continue;
      }
      const isNumber = entry.valueType === "number";
      described.push({
        id: entry.id,
        code: entry.code,
        name: nameOf(attributeTexts, entry.id, lang),
        valueType: entry.valueType,
        unit: isNumber ? localize(textsOf(attributeTexts, entry.id, "unit"), lang) : null,
        number: isNumber
          ? {
              integer: entry.numberInteger ?? false,
              min: entry.numberMin === null ? null : Number(entry.numberMin),
              max: entry.numberMax === null ? null : Number(entry.numberMax),
            }
          : null,
        options: own.map((option) => ({
          id: option.id,
          code: option.code,
          name: nameOf(optionTexts, option.id, lang),
        })),
        isFilterable: entry.isFilterable,
        isRequiredForComplete: entry.isRequiredForComplete,
        sort: entry.sort,
      });
    }
    return {
      language: lang,
      category: {
        ...this.describe(row, categoryTexts, lang),
        level: row.level,
        parentId: row.parentId,
      },
      attributes: described,
    };
  }

  /** Missing, hidden, archived or under a hidden/archived node — the same 404. */
  private async visibleCategory(categoryId: string): Promise<CategoryRow> {
    if (!UUID.test(categoryId)) {
      throw notFound("category");
    }
    const [row] = await this.database.db.select().from(category).where(eq(category.id, categoryId));
    if (!row || row.status !== "active") {
      throw notFound("category");
    }
    if (row.parentId) {
      const [parent] = await this.database.db
        .select({ status: category.status })
        .from(category)
        .where(eq(category.id, row.parentId));
      if (parent?.status !== "active") {
        throw notFound("category");
      }
    }
    return row;
  }

  private describe(row: CategoryRow, texts: TextIndex, lang: CatalogLanguage): CategorySubcategory {
    return {
      id: row.id,
      code: row.code,
      kind: row.kind,
      name: nameOf(texts, row.id, lang),
      icon: row.icon as CategoryIcon | null,
      sort: row.sort,
      compatibilityRequired: row.compatibilityRequired,
    };
  }
}
