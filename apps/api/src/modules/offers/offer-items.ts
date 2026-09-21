import type { CatalogLanguage, OfferItem } from "@adclub/contracts";
import { and, eq, inArray } from "drizzle-orm";
import type { DbExecutor } from "../../database";
import {
  brandSpelling,
  catalogItem,
  category,
  loadTexts,
  localize,
  textsOf,
  type CatalogPhotosService,
} from "../catalog";

const NO_NAME = { text: "", isFallback: true };

/**
 * Catalog items as offers show them (S-OFF-01…03): the name, the
 * subcategory and its node in the language of the request (Russian as the
 * fallback), the brand, the article and the primary photo — a thumbnail
 * and a card size, never the full picture.
 */
export async function describeOfferItems(
  executor: DbExecutor,
  photos: CatalogPhotosService,
  itemIds: readonly string[],
  lang: CatalogLanguage,
): Promise<Map<string, OfferItem>> {
  const described = new Map<string, OfferItem>();
  const ids = [...new Set(itemIds)];
  if (ids.length === 0) {
    return described;
  }
  const items = await executor.select().from(catalogItem).where(inArray(catalogItem.id, ids));
  const subcategoryIds = [...new Set(items.map((row) => row.categoryId))];
  const subcategories =
    subcategoryIds.length === 0
      ? []
      : await executor.select().from(category).where(inArray(category.id, subcategoryIds));
  const parentIds = [
    ...new Set(subcategories.flatMap((row) => (row.parentId ? [row.parentId] : []))),
  ];
  const brandIds = [...new Set(items.flatMap((row) => (row.brandId ? [row.brandId] : [])))];
  const [itemTexts, categoryTexts, brands, images] = await Promise.all([
    loadTexts(executor, "catalog_item", ids),
    loadTexts(executor, "category", [...subcategoryIds, ...parentIds]),
    brandIds.length === 0
      ? Promise.resolve([])
      : executor
          .select({ brandId: brandSpelling.brandId, name: brandSpelling.text })
          .from(brandSpelling)
          .where(and(inArray(brandSpelling.brandId, brandIds), eq(brandSpelling.isName, true))),
    photos.imagesFor(executor, items),
  ]);
  const brandNames = new Map(brands.map((row) => [row.brandId, row.name]));
  const subcategoryById = new Map(subcategories.map((row) => [row.id, row]));
  for (const row of items) {
    if (row.itemType === "service") {
      continue;
    }
    const subcategory = subcategoryById.get(row.categoryId);
    const brandName = row.brandId ? brandNames.get(row.brandId) : undefined;
    described.set(row.id, {
      id: row.id,
      type: row.itemType,
      status: row.status,
      name: localize(textsOf(itemTexts, row.id, "name"), lang) ?? NO_NAME,
      article: row.article,
      brand: row.brandId && brandName ? { id: row.brandId, name: brandName } : null,
      category: {
        id: row.categoryId,
        name: localize(textsOf(categoryTexts, row.categoryId, "name"), lang) ?? NO_NAME,
        parentName: subcategory?.parentId
          ? localize(textsOf(categoryTexts, subcategory.parentId, "name"), lang)
          : null,
      },
      photo: images.get(row.id) ?? null,
    });
  }
  return described;
}
