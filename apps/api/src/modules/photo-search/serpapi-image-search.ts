import { z } from "zod";
import {
  ImageSearchUnavailable,
  type ImageSearchProvider,
  type ImageSearchResult,
} from "./image-search-provider";

/** Where SerpAPI is. */
export const SERPAPI_URL = "https://serpapi.com/search.json";

/**
 * Google Images through SerpAPI (ARCHITECTURE 9.7 variant A; TASK-068):
 * `engine=google_images`, the result's `original` is the picture and `link`
 * the page it is on. The standard `fetch`, no SDK; the key travels in the
 * query string as SerpAPI asks, so the address is never logged or put into
 * an error. **Never called in this task** (no key yet): checked on a
 * substituted `fetch` only.
 */

const resultSchema = z.object({
  original: z.unknown().optional(),
  link: z.unknown().optional(),
  title: z.unknown().optional(),
});

const answerSchema = z.object({
  images_results: z.array(z.unknown()).optional(),
  error: z.string().optional(),
});

function httpUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2000) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * SerpAPI's answer as results: only entries with an `http(s)` picture and
 * page; anything else in the answer is ignored. «No results» from Google is
 * an empty list, not a failure.
 */
export function parseSerpApiAnswer(body: unknown, limit: number): ImageSearchResult[] {
  const parsed = answerSchema.safeParse(body);
  if (!parsed.success) {
    throw new ImageSearchUnavailable("unavailable", "unexpected answer");
  }
  if (parsed.data.error && !parsed.data.images_results) {
    if (/hasn't returned any results|no results/i.test(parsed.data.error)) return [];
    throw new ImageSearchUnavailable("unavailable", "the provider reported an error");
  }
  const results: ImageSearchResult[] = [];
  for (const entry of parsed.data.images_results ?? []) {
    const item = resultSchema.safeParse(entry);
    if (!item.success) continue;
    const imageUrl = httpUrl(item.data.original);
    const pageUrl = httpUrl(item.data.link);
    if (!imageUrl || !pageUrl) continue;
    const title =
      typeof item.data.title === "string" && item.data.title.trim() !== ""
        ? item.data.title.trim().slice(0, 300)
        : null;
    results.push({ imageUrl, pageUrl, title });
    if (results.length >= limit) break;
  }
  return results;
}

export interface SerpApiOptions {
  apiKey: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

export class SerpApiImageSearch implements ImageSearchProvider {
  readonly name = "serpapi";
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: SerpApiOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.baseUrl = options.baseUrl ?? SERPAPI_URL;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  async search(query: string, limit: number): Promise<ImageSearchResult[]> {
    const url = new URL(this.baseUrl);
    url.searchParams.set("engine", "google_images");
    url.searchParams.set("q", query);
    url.searchParams.set("hl", "ru");
    url.searchParams.set("gl", "kz");
    url.searchParams.set("safe", "active");
    url.searchParams.set("api_key", this.options.apiKey);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
      });
    } catch {
      // The cause may name the address with the key: it is not kept.
      throw new ImageSearchUnavailable("unavailable", "no answer");
    }
    if (response.status === 401 || response.status === 403) {
      throw new ImageSearchUnavailable("rejected", `status ${String(response.status)}`);
    }
    if (!response.ok) {
      throw new ImageSearchUnavailable("unavailable", `status ${String(response.status)}`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ImageSearchUnavailable("unavailable", "not JSON");
    }
    return parseSerpApiAnswer(body, limit);
  }
}
