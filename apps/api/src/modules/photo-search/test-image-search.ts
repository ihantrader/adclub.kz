import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isIP } from "node:net";
import { z } from "zod";
import {
  ImageSearchUnavailable,
  type ImageSearchProvider,
  type ImageSearchResult,
} from "./image-search-provider";
import { isBlockedAddress, PhotoFetchRefused, type PhotoFetcher } from "./photo-fetcher";

/**
 * The test image search (TASK-068): `apps/api/fixtures/photo-search` —
 * made-up pages and pictures, no network (development, tests and CI). The
 * search answers by the article in the query; the downloader «resolves»
 * the names of `hosts` and refuses a private address with the same rule as
 * the real one (`isBlockedAddress`), then hands out the fixture file.
 */

export const PHOTO_SEARCH_FIXTURES = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "fixtures",
  "photo-search",
);

const fixturesSchema = z.object({
  hosts: z.record(z.string(), z.string()),
  queries: z.array(
    z.object({
      match: z.string(),
      results: z.array(
        z.object({
          imageUrl: z.string(),
          pageUrl: z.string(),
          title: z.string().nullable(),
          file: z.string(),
        }),
      ),
    }),
  ),
});

type Fixtures = z.infer<typeof fixturesSchema>;

export function loadPhotoSearchFixtures(directory = PHOTO_SEARCH_FIXTURES): Fixtures {
  return fixturesSchema.parse(JSON.parse(readFileSync(join(directory, "fixtures.json"), "utf8")));
}

/** The query as fixtures match it: upper case, no spaces, dashes or dots. */
function matchKey(text: string): string {
  return text.toUpperCase().replace(/[\s\-./]+/g, "");
}

export class TestImageSearch implements ImageSearchProvider {
  readonly name = "test";
  /** Queries the search was asked, newest last (tests read it). */
  readonly queries: string[] = [];

  constructor(
    private readonly fixtures: Fixtures,
    public mode: "ok" | "unavailable" = "ok",
  ) {}

  search(query: string, limit: number): Promise<ImageSearchResult[]> {
    this.queries.push(query);
    if (this.mode === "unavailable") {
      return Promise.reject(new ImageSearchUnavailable("unavailable", "test mode"));
    }
    const key = matchKey(query);
    const entry =
      this.fixtures.queries.find(
        (candidate) => candidate.match !== "*" && key.includes(candidate.match),
      ) ?? this.fixtures.queries.find((candidate) => candidate.match === "*");
    return Promise.resolve(
      (entry?.results ?? []).slice(0, limit).map(({ imageUrl, pageUrl, title }) => ({
        imageUrl,
        pageUrl,
        title,
      })),
    );
  }
}

export class FixturePhotoFetcher implements PhotoFetcher {
  /** Addresses the fetcher was asked for, in order (tests read it). */
  readonly fetched: string[] = [];
  private readonly files = new Map<string, string>();

  constructor(
    private readonly fixtures: Fixtures,
    private readonly directory = PHOTO_SEARCH_FIXTURES,
  ) {
    for (const query of fixtures.queries) {
      for (const result of query.results) this.files.set(result.imageUrl, result.file);
    }
  }

  fetch(url: string, maxBytes: number): Promise<Buffer> {
    this.fetched.push(url);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return Promise.reject(new PhotoFetchRefused("download_failed", "not an address"));
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return Promise.reject(new PhotoFetchRefused("download_failed", "not http(s)"));
    }
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    const address = isIP(host) !== 0 ? host : this.fixtures.hosts[host];
    if (!address) {
      return Promise.reject(new PhotoFetchRefused("download_failed", "no address"));
    }
    if (isBlockedAddress(address)) {
      return Promise.reject(new PhotoFetchRefused("private_address", "resolved address"));
    }
    const file = this.files.get(url);
    if (!file) {
      return Promise.reject(new PhotoFetchRefused("download_failed", "status 404"));
    }
    const bytes = readFileSync(join(this.directory, file));
    if (bytes.byteLength > maxBytes) {
      return Promise.reject(new PhotoFetchRefused("too_large", "body"));
    }
    return Promise.resolve(bytes);
  }
}
