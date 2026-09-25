import { Inject, Injectable } from "@nestjs/common";
import {
  OFFER_ITEM_SEARCH_MAX_RESULTS,
  type CatalogLanguage,
  type OfferItemSearchQuery,
  type OfferItemSearchResponse,
  type OfferStatusValue,
} from "@adclub/contracts";
import { normalizeArticle } from "@adclub/domain";
import { sql } from "drizzle-orm";
import { DatabaseService } from "../../database";
import { CatalogPhotosService, escapeLike, normalizeText } from "../catalog";
import { describeOfferItems } from "./offer-items";
import type { OfferActor } from "./offers.service";

interface FoundRow extends Record<string, unknown> {
  id: string;
  offer_id: string | null;
  offer_status: OfferStatusValue | null;
}

/**
 * The search of a catalog item for an offer (TASK-018 requirement 2;
 * SCREENS S-OFF-02; ARCHITECTURE 4.28). The catalog is never given out
 * whole: only by a query of at least three letters or digits (the
 * contract), only active parts and products of visible subcategories, a
 * page of at most 20 and no further than the first 100 matches of a
 * query, and a limit of searches per employee the route declares in the
 * contract (`offer_item_search_per_member` per `…_window_seconds`,
 * counted by `RouteRateLimitGuard` — TASK-023). The same match
 * as the administrator's search (4.17): a part of the normalized article
 * — spaces, hyphens and case don't matter — or a part of the name in any
 * language; an exact article first, then one that begins with the query.
 */
@Injectable()
export class OfferItemSearch {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(CatalogPhotosService) private readonly photos: CatalogPhotosService,
  ) {}

  async search(
    actor: OfferActor,
    query: OfferItemSearchQuery,
    lang: CatalogLanguage,
  ): Promise<OfferItemSearchResponse> {
    const article = normalizeArticle(query.q);
    const pattern = `%${escapeLike(normalizeText(query.q))}%`;
    const byName = sql`EXISTS (SELECT 1 FROM translation t WHERE t.entity_type = 'catalog_item' AND t.entity_id = i.id AND t.field = 'name' AND lower(t.text) LIKE lower(${pattern}) ESCAPE '\\')`;
    const matches =
      article === "" ? byName : sql`(strpos(i.article_norm, ${article}) > 0 OR ${byName})`;
    const rank =
      article === ""
        ? sql`2`
        : sql`CASE WHEN i.article_norm = ${article} THEN 0 WHEN strpos(i.article_norm, ${article}) = 1 THEN 1 ELSE 2 END`;
    const found = await this.database.db.execute<FoundRow>(sql`
      SELECT i.id, o.id AS offer_id, o.status AS offer_status
      FROM catalog_item i
      JOIN category c ON c.id = i.category_id
      LEFT JOIN category p ON p.id = c.parent_id
      LEFT JOIN offer o ON o.item_id = i.id AND o.supplier_id = ${actor.supplierId}::uuid
      WHERE i.item_type IN ('part', 'generic')
        AND i.status = 'active'
        AND c.status = 'active' AND coalesce(p.status, 'active') = 'active'
        AND ${matches}
      ORDER BY ${rank}, i.created_at DESC, i.id DESC
      LIMIT ${query.limit + 1} OFFSET ${query.offset}
    `);
    const rows = found.rows.slice(0, query.limit);
    const items = await describeOfferItems(
      this.database.db,
      this.photos,
      rows.map((row) => row.id),
      lang,
    );
    const next = query.offset + query.limit;
    return {
      language: lang,
      results: rows.map((row) => ({
        item: items.get(row.id)!,
        offer:
          row.offer_id && row.offer_status ? { id: row.offer_id, status: row.offer_status } : null,
      })),
      nextOffset:
        found.rows.length > query.limit && next < OFFER_ITEM_SEARCH_MAX_RESULTS ? next : null,
    };
  }
}
