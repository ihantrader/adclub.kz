import { Inject, Injectable, Logger } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config";
import { Metrics } from "../../observability";
import {
  MeiliClient,
  SearchIndexMissingError,
  SearchIndexUnavailableError,
  type MeiliSearchQuery,
} from "./meilisearch";
import { SEARCH_INDEX_CANDIDATES_MAX } from "./search-document";

/** A query of the users' search waits this long for the index, then PostgreSQL answers. */
export const SEARCH_QUERY_TIMEOUT_MS = 1500;
/** The worker's requests (documents, settings, tasks) wait this long. */
export const SEARCH_WRITE_TIMEOUT_MS = 30_000;
/** At most one warning a minute that the index did not answer (the metric counts every one). */
const WARNING_INTERVAL_MS = 60_000;

export function meiliClient(config: AppConfig, timeoutMs: number): MeiliClient | null {
  return config.search.url
    ? new MeiliClient({ url: config.search.url, apiKey: config.search.apiKey, timeoutMs })
    : null;
}

export interface SearchIndexRequest {
  /** The keys of the variants of the query (`searchKey`), the query as typed first. */
  variants: readonly string[];
  /** The chosen city: a service only in it (goods from anywhere). */
  cityId?: string | null;
}

export interface SearchIndexCandidate {
  /** The ranking score of the index, the best of the variants (0…1). */
  score: number;
  /** Which variant found it best. */
  variant: number;
  /** Its popularity as the document holds it. */
  popularity: number;
}

const quoted = (value: string) => `"${value.replace(/["\\]/g, "")}"`;

/**
 * The search index as the users' search reads it (TASK-045; ARCHITECTURE
 * 10.2, 4.65). It only finds and ranks candidates; what is shown of them is
 * decided by the catalog's functions on PostgreSQL. `find` answers `null`
 * when there is no index or it did not answer in time — the search then
 * answers from PostgreSQL (TASK-044), counted in
 * `adclub_search_index_fallbacks_total` and warned of in the log (at most
 * once a minute). `/ready` does not look at it (I17): the API is ready
 * without the index.
 */
@Injectable()
export class SearchIndex {
  private readonly logger = new Logger("SearchIndex");
  private readonly client: MeiliClient | null;
  private lastWarning = 0;

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(Metrics) private readonly metrics: Metrics,
  ) {
    this.client = meiliClient(config, SEARCH_QUERY_TIMEOUT_MS);
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  /**
   * The candidates of the variants of a query: one `multi-search` with each
   * variant twice — every word must match (`all`), and, used only when that
   * finds nothing at all, the words from the end may be dropped (`last`).
   * Merged by item, the best score kept.
   */
  async find(request: SearchIndexRequest): Promise<Map<string, SearchIndexCandidate> | null> {
    if (!this.client || request.variants.length === 0) {
      return this.client ? new Map() : null;
    }
    const filter: (string | string[])[] = [];
    if (request.cityId) {
      filter.push([`kind = "goods"`, `cities = ${quoted(request.cityId)}`]);
    }
    const queries: MeiliSearchQuery[] = (["all", "last"] as const).flatMap((strategy) =>
      request.variants.map((q) => ({
        indexUid: this.config.search.index,
        q,
        limit: SEARCH_INDEX_CANDIDATES_MAX,
        attributesToRetrieve: ["id", "popularity"],
        showRankingScore: true,
        matchingStrategy: strategy,
        ...(filter.length > 0 ? { filter } : {}),
      })),
    );
    let results;
    try {
      ({ results } = await this.client.multiSearch(queries));
    } catch (error) {
      const reason =
        error instanceof SearchIndexMissingError
          ? "missing"
          : error instanceof SearchIndexUnavailableError
            ? "unavailable"
            : "refused";
      this.metrics.countSearchFallback(reason);
      if (Date.now() - this.lastWarning > WARNING_INTERVAL_MS) {
        this.lastWarning = Date.now();
        this.logger.warn(
          `The search index did not answer (${reason}): searching PostgreSQL — ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return null;
    }
    const merge = (from: number, to: number) => {
      const found = new Map<string, SearchIndexCandidate>();
      for (let index = from; index < to; index += 1) {
        const variant = index - from;
        for (const hit of results[index]?.hits ?? []) {
          const score = typeof hit._rankingScore === "number" ? hit._rankingScore : 0;
          const known = found.get(hit.id);
          if (!known || score > known.score) {
            const popularity = typeof hit.popularity === "number" ? hit.popularity : 0;
            found.set(hit.id, { score, variant, popularity });
          }
        }
      }
      return found;
    };
    const count = request.variants.length;
    const strict = merge(0, count);
    return strict.size > 0 ? strict : merge(count, count * 2);
  }
}
