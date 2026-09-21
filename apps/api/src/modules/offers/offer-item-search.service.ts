import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  OFFER_ITEM_SEARCH_MAX_RESULTS,
  type CatalogLanguage,
  type OfferItemSearchQuery,
  type OfferItemSearchResponse,
  type OfferStatusValue,
} from "@adclub/contracts";
import { normalizeArticle } from "@adclub/domain";
import { sql } from "drizzle-orm";
import { rateLimitedException } from "../../common/errors";
import { DatabaseService } from "../../database";
import { Metrics } from "../../observability";
import { RateLimiterService, RateLimiterUnavailableError } from "../../redis";
import { CatalogPhotosService, escapeLike, normalizeText } from "../catalog";
import { AppSettings } from "../settings";
import { describeOfferItems } from "./offer-items";
import type { OfferActor } from "./offers.service";

/** How often a search served without a working limiter is reported (not every request). */
const UNAVAILABLE_WARNING_INTERVAL_MS = 60_000;

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
 * query, and a limit of searches per employee (the settings
 * `offer_item_search_per_member` per `…_window_seconds`). The same match
 * as the administrator's search (4.17): a part of the normalized article
 * — spaces, hyphens and case don't matter — or a part of the name in any
 * language; an exact article first, then one that begins with the query.
 */
@Injectable()
export class OfferItemSearch {
  private readonly logger = new Logger("Offers");
  private lastUnavailableWarning = 0;

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(RateLimiterService) private readonly limiter: RateLimiterService,
    @Inject(Metrics) private readonly metrics: Metrics,
    @Inject(CatalogPhotosService) private readonly photos: CatalogPhotosService,
  ) {}

  async search(
    actor: OfferActor,
    query: OfferItemSearchQuery,
    lang: CatalogLanguage,
  ): Promise<OfferItemSearchResponse> {
    await this.countSearch(actor.memberId);
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

  /**
   * One search of the employee against the limit. Redis down — the search
   * is served (it reads, like the other reads, 4.26 I255) and the outage
   * is reported once a minute; the page and result bounds still hold.
   */
  private async countSearch(memberId: string): Promise<void> {
    const [max, windowSeconds] = await Promise.all([
      this.settings.get("offer_item_search_per_member"),
      this.settings.get("offer_item_search_per_member_window_seconds"),
    ]);
    let hit;
    try {
      hit = await this.limiter.hit(`offer-item-search:${memberId}`, { max, windowSeconds });
    } catch (error) {
      if (!(error instanceof RateLimiterUnavailableError)) {
        throw error;
      }
      const now = Date.now();
      if (now - this.lastUnavailableWarning >= UNAVAILABLE_WARNING_INTERVAL_MS) {
        this.lastUnavailableWarning = now;
        this.logger.warn(`Item search served without the limit: ${error.message}`);
      }
      return;
    }
    if (!hit.allowed) {
      this.metrics.countRateLimitHit("offer_item_search_per_member");
      this.logger.warn(`Rate limit hit limit=offer_item_search_per_member member=${memberId}`);
      throw rateLimitedException("offer_item_search_per_member", hit.retryAfterSeconds);
    }
  }
}
