/**
 * The port of the image search (TASK-068, D-076; ARCHITECTURE 9.7, 4.95),
 * like `MessageChannel` and `AiGateway`: the module asks one question —
 * pictures for this query — and never sees which provider answered. The
 * implementations: `TestImageSearch` (fixtures, no network: development,
 * tests and CI) and `SerpApiImageSearch` (Google Images through SerpAPI, on
 * the standard `fetch`, no SDK). Nothing here generates a picture.
 */

/** One picture the provider found: the file and the page it is on. */
export interface ImageSearchResult {
  /** The address of the picture itself. */
  imageUrl: string;
  /** The page the picture is on — what the administrator opens, `source_url`. */
  pageUrl: string;
  title: string | null;
}

export interface ImageSearchProvider {
  /** The provider's name, kept with each search (`photo_search.provider`). */
  readonly name: string;
  /** Up to `limit` results, in the provider's order. */
  search(query: string, limit: number): Promise<ImageSearchResult[]>;
}

/**
 * The provider did not answer — `unavailable` (network, timeout, its error,
 * its rate limit) or refused the key (`rejected`). Nothing is retried within
 * the search: the button says so, the job tries the item another day.
 */
export class ImageSearchUnavailable extends Error {
  constructor(
    readonly kind: "unavailable" | "rejected",
    detail: string,
  ) {
    super(`The image search did not answer: ${kind} (${detail})`);
    this.name = "ImageSearchUnavailable";
  }
}

/** The DI token of the provider; `null` — no search here (`disabled`). */
export const IMAGE_SEARCH_PROVIDER = Symbol("IMAGE_SEARCH_PROVIDER");

/** The DI token of the downloader of pictures (`PhotoFetcher`). */
export const PHOTO_FETCHER = Symbol("PHOTO_FETCHER");
