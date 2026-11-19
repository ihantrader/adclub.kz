import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  auditActions,
  auditEntities,
  ITEM_PHOTOS_MAX,
  type PhotoSearchOutcome,
  type PhotoSearchSkipReason,
  type PhotoSearchUnavailableDetails,
  type SearchItemPhotosResponse,
} from "@adclub/contracts";
import { eq, sql } from "drizzle-orm";
import { ApiException, rateLimitedException } from "../../common/errors";
import { DatabaseService } from "../../database";
import { AuditLog, type AuditActorRecord } from "../audit";
import {
  CatalogPhotosService,
  catalogItem,
  loadTexts,
  photoSearch,
  PhotoRejected,
  prepareImage,
  textsOf,
  type PreparedImage,
} from "../catalog";
import { AppSettings } from "../settings";
import {
  IMAGE_SEARCH_PROVIDER,
  ImageSearchUnavailable,
  PHOTO_FETCHER,
  type ImageSearchProvider,
  type ImageSearchResult,
} from "./image-search-provider";
import { differenceHash } from "./perceptual-hash";
import { PhotoFetchRefused, type PhotoFetcher } from "./photo-fetcher";
import {
  brandKeys,
  hostOf,
  rankCandidates,
  trustedSourceOf,
  type RankInput,
  type TrustedDomains,
} from "./photo-ranking";

/** How many results of the provider one search looks at. */
export const PHOTO_SEARCH_RESULTS = 20;
/** Downloads of one search at a time. */
const DOWNLOADS_AT_ONCE = 4;

export type PhotoSearchTrigger = "admin" | "job";

/** The search can't run now: provider, budget or the item. */
export class PhotoSearchSkipped extends Error {
  constructor(readonly reason: "disabled" | "budget" | "not_applicable" | "provider") {
    super(`Photo search skipped: ${reason}`);
    this.name = "PhotoSearchSkipped";
  }
}

function unavailable(reason: PhotoSearchUnavailableDetails["reason"]): ApiException {
  const details: PhotoSearchUnavailableDetails = { reason };
  return new ApiException(
    503,
    "PHOTO_SEARCH_UNAVAILABLE",
    reason === "disabled"
      ? "No image search is configured here"
      : "The image search did not answer, try again later",
    { details, retryable: reason === "provider" },
  );
}

/** Start of the Almaty day, as the database computes it. */
const ALMATY_DAY_START = sql`(date_trunc('day', now() AT TIME ZONE 'Asia/Almaty') AT TIME ZONE 'Asia/Almaty')`;

/**
 * The image search of photos of items (TASK-068, D-076; PRODUCT 7.6;
 * ARCHITECTURE 9.7, 4.95). One search:
 *
 * 1. the item must be an active product (not a service); the query is
 *    «бренд + артикул + название»;
 * 2. the day's budget `photo_search_per_day` (Almaty) is taken first — a
 *    `photo_search` row written under an advisory lock, so two searches can't
 *    both take the last one; the provider's failure still counts (it was a
 *    request);
 * 3. the provider's results are downloaded through the SSRF guard
 *    (`PhotoFetcher`), each checked by its content like an upload
 *    (`prepareImage`) — a broken file, not a picture or SVG make no
 *    candidate;
 * 4. ranked (`rankCandidates`): the brand's sites first, then the same
 *    picture on several sites; up to `photo_search_candidates` become
 *    `item_photo` in `proposed`, `proposed_by = 'ai'`, with the page they
 *    came from — the moderation queue. A picture the item has or had is not
 *    proposed again.
 */
@Injectable()
export class PhotoSearchService {
  private readonly logger = new Logger("PhotoSearch");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(AuditLog) private readonly audit: AuditLog,
    @Inject(CatalogPhotosService) private readonly photos: CatalogPhotosService,
    @Inject(IMAGE_SEARCH_PROVIDER) private readonly provider: ImageSearchProvider | null,
    @Inject(PHOTO_FETCHER) private readonly fetcher: PhotoFetcher,
  ) {}

  get enabled(): boolean {
    return this.provider !== null;
  }

  /** «Найти фото» of the administrator: the photos of the item after the search. */
  async searchByAdmin(
    itemId: string,
    actor: Extract<AuditActorRecord, { role: "admin" }>,
  ): Promise<SearchItemPhotosResponse> {
    try {
      const search = await this.search(itemId, "admin", actor);
      return { ...(await this.photos.list(itemId)), search };
    } catch (error) {
      if (!(error instanceof PhotoSearchSkipped)) throw error;
      switch (error.reason) {
        case "disabled":
          throw unavailable("disabled");
        case "provider":
          throw unavailable("provider");
        case "not_applicable":
          throw new ApiException(
            409,
            "PHOTO_SEARCH_NOT_APPLICABLE",
            "Photos are searched for products of the catalog only — not for services or archived items",
          );
        case "budget": {
          const wait = await this.database.db.execute<{ seconds: number }>(
            sql`SELECT extract(epoch FROM ${ALMATY_DAY_START} + interval '1 day' - now())::float AS seconds`,
          );
          throw rateLimitedException("photo_search_per_day", Number(wait.rows[0]?.seconds ?? 3600));
        }
      }
    }
  }

  /** Searches left for the Almaty day. */
  async remainingToday(): Promise<number> {
    const limit = await this.settings.get("photo_search_per_day");
    const used = await this.database.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM photo_search WHERE created_at >= ${ALMATY_DAY_START}`,
    );
    return Math.max(0, limit - Number(used.rows[0]?.n ?? 0));
  }

  /** One search; `PhotoSearchSkipped` when it can't run. */
  async search(
    itemId: string,
    trigger: PhotoSearchTrigger,
    actor: AuditActorRecord,
  ): Promise<PhotoSearchOutcome> {
    if (!this.provider) throw new PhotoSearchSkipped("disabled");
    const db = this.database.db;
    const [item] = await db.select().from(catalogItem).where(eq(catalogItem.id, itemId));
    if (!item) throw new ApiException(404, "NOT_FOUND", "No such item");
    if (item.status !== "active" || item.itemType === "service") {
      throw new PhotoSearchSkipped("not_applicable");
    }
    const [brand] = item.brandId
      ? (
          await db.execute<{ name: string; spellings: string[] }>(sql`
            SELECT coalesce(max(s.text) FILTER (WHERE s.is_name), '') AS name,
                   coalesce(array_agg(s.text), '{}') AS spellings
            FROM brand_spelling s WHERE s.brand_id = ${item.brandId}`)
        ).rows
      : [];
    const texts = await loadTexts(db, "catalog_item", [item.id]);
    const name = textsOf(texts, item.id, "name").ru?.text ?? null;
    const query = [brand?.name, item.article, name]
      .filter((part): part is string => Boolean(part && part.trim()))
      .join(" ")
      .slice(0, 300);
    if (!query) throw new PhotoSearchSkipped("not_applicable");

    // Settings are read before the transaction (never a second connection in it).
    const [perDay, candidatesLimit, trusted] = await Promise.all([
      this.settings.get("photo_search_per_day"),
      this.settings.get("photo_search_candidates"),
      this.settings.get("photo_search_trusted_domains"),
    ]);
    const searchId = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('photo-search-budget'))`);
      const used = await tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM photo_search WHERE created_at >= ${ALMATY_DAY_START}`,
      );
      if (Number(used.rows[0]?.n ?? 0) >= perDay) return null;
      const [row] = await tx
        .insert(photoSearch)
        .values({
          itemId,
          trigger,
          requestedBy: actor.role === "admin" ? actor.accountId : null,
          provider: this.provider!.name,
          query,
        })
        .returning({ id: photoSearch.id });
      return row!.id;
    });
    if (!searchId) throw new PhotoSearchSkipped("budget");

    let results: ImageSearchResult[];
    try {
      results = await this.provider.search(query, PHOTO_SEARCH_RESULTS);
    } catch (error) {
      const kind = error instanceof ImageSearchUnavailable ? error.kind : "unavailable";
      await db
        .update(photoSearch)
        .set({ status: "unavailable", error: kind, finishedAt: new Date() })
        .where(eq(photoSearch.id, searchId));
      this.logger.warn(`Image search unavailable item=${itemId} kind=${kind}`);
      throw new PhotoSearchSkipped("provider");
    }

    try {
      const outcome = await this.collect(
        itemId,
        results,
        brandKeys([brand?.name ?? "", ...(brand?.spellings ?? [])]),
        trusted,
        candidatesLimit,
        actor,
      );
      await db.transaction(async (tx) => {
        await tx
          .update(photoSearch)
          .set({
            status: "done",
            results: outcome.results,
            candidates: outcome.candidates,
            skipped: Object.fromEntries(
              outcome.skipped.map((entry) => [entry.reason, entry.count]),
            ),
            finishedAt: new Date(),
          })
          .where(eq(photoSearch.id, searchId));
        await tx
          .update(catalogItem)
          .set({
            photoSearchAt: sql`now()`,
            photoSearchCount: sql`${catalogItem.photoSearchCount} + 1`,
          })
          .where(eq(catalogItem.id, itemId));
        await this.audit.record(
          {
            action: auditActions.catalogItemPhotoSearched,
            actor,
            entityType: auditEntities.catalogItem,
            entityId: itemId,
            after: {
              trigger,
              provider: this.provider!.name,
              results: outcome.results,
              candidates: outcome.candidates,
            },
          },
          tx,
        );
      });
      this.logger.log(
        `Photo search item=${itemId} trigger=${trigger} results=${String(outcome.results)} candidates=${String(outcome.candidates)}`,
      );
      return outcome;
    } catch (error) {
      await db
        .update(photoSearch)
        .set({
          status: "failed",
          error: error instanceof Error ? error.name : "error",
          finishedAt: new Date(),
        })
        .where(eq(photoSearch.id, searchId));
      throw error;
    }
  }

  /** Downloads, checks and ranks the results, and stores the candidates. */
  private async collect(
    itemId: string,
    results: readonly ImageSearchResult[],
    keys: readonly string[],
    trusted: TrustedDomains,
    limit: number,
    actor: AuditActorRecord,
  ): Promise<PhotoSearchOutcome> {
    const skipped = new Map<PhotoSearchSkipReason, number>();
    const skip = (reason: PhotoSearchSkipReason) =>
      skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
    const maxBytes = (await this.settings.get("photo_max_size_mb")) * 1024 * 1024;
    const known = await this.photos.knownChecksums(itemId);
    const room = Math.max(0, ITEM_PHOTOS_MAX - (await this.photos.activeCount(itemId)));

    // Every result is downloaded (at most `PHOTO_SEARCH_RESULTS`): whether a
    // shop's picture is on another site too is known only from the pictures.
    const downloaded = new Map<
      number,
      { prepared: PreparedImage; hash: string; host: string; result: ImageSearchResult }
    >();
    const queue = results.map((result, index) => ({ result, index }));
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const { result, index } = next;
        const host = hostOf(result.imageUrl);
        const pageHost = hostOf(result.pageUrl);
        if (!host || !pageHost) {
          skip("download_failed");
          continue;
        }
        let bytes: Buffer;
        try {
          bytes = await this.fetcher.fetch(result.imageUrl, maxBytes);
        } catch (error) {
          skip(error instanceof PhotoFetchRefused ? error.reason : "download_failed");
          continue;
        }
        let prepared: PreparedImage;
        try {
          prepared = await prepareImage(bytes);
        } catch (error) {
          if (error instanceof PhotoRejected) {
            skip(
              error.reason === "unsupported_format" ||
                error.reason === "broken" ||
                error.reason === "too_many_pixels"
                ? error.reason
                : "not_an_image",
            );
            continue;
          }
          throw error;
        }
        const card = prepared.variants.find((variant) => variant.variant === "thumb")!;
        downloaded.set(index, {
          prepared,
          hash: await differenceHash(card.bytes),
          // The site of a picture is the page it is on (an image may live on a CDN).
          host: pageHost,
          result,
        });
      }
    };
    await Promise.all(Array.from({ length: DOWNLOADS_AT_ONCE }, () => worker()));

    const inputs: RankInput[] = [];
    for (const [index, entry] of [...downloaded.entries()].sort((a, b) => a[0] - b[0])) {
      if (known.has(entry.prepared.checksum)) {
        skip("already_known");
        continue;
      }
      // Byte-identical copies have one hash: the ranking groups them as one picture.
      inputs.push({
        index,
        host: entry.host,
        hash: entry.hash,
        pixels: entry.prepared.width * entry.prepared.height,
      });
    }
    const ranked = rankCandidates(
      inputs,
      (host) => trustedSourceOf(host, keys, trusted),
      Math.min(limit, room),
    );
    for (const reason of ranked.skipped.values()) skip(reason);

    let candidates = 0;
    for (const candidate of ranked.chosen) {
      const entry = downloaded.get(candidate.index)!;
      const { created } = await this.photos.addFoundCandidate(
        itemId,
        entry.prepared,
        {
          sourceType: candidate.sourceType,
          sourceUrl: entry.result.pageUrl,
          score: candidate.score,
          evidence: {
            imageUrl: entry.result.imageUrl,
            title: entry.result.title,
            sites: candidate.sites,
            pages: candidate.members.map((index) => downloaded.get(index)!.result.pageUrl),
            hash: entry.hash,
          },
        },
        actor,
      );
      if (created) candidates += 1;
      else skip("already_known");
    }
    return {
      results: results.length,
      candidates,
      skipped: [...skipped.entries()].map(([reason, count]) => ({ reason, count })),
    };
  }
}
