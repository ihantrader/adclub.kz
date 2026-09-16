/**
 * Canonical form used for `catalog_item.article_norm` (ARCHITECTURE 5.2), so that
 * articles written inconsistently by suppliers ("123-456", "123 456", "abc.123")
 * collide onto the same catalog item instead of creating duplicates.
 */
export function normalizeArticle(article: string): string {
  return article.toUpperCase().replace(/[^A-Z0-9Ѐ-ӿ]+/g, "");
}
