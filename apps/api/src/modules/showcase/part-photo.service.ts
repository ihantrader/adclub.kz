import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  SHOWCASE_PAGE_DEFAULT_SIZE,
  type CatalogLanguage,
  type CatalogSearchItem,
  type CatalogSearchResponse,
  type PartPhotoArticle,
  type PartPhotoQuery,
  type PartPhotoResponse,
} from "@adclub/contracts";
import { articleQuery } from "@adclub/domain";
import { and, eq, inArray, or } from "drizzle-orm";
import { DatabaseService } from "../../database";
import { AiService, type PartPhotoOutput } from "../ai";
import { catalogItem, itemAnalog } from "../catalog";
import { PhotoRecognitions, type DocumentReader } from "../vehicle-document";
import { CatalogSearchService } from "./catalog-search.service";
import type { Viewer } from "./showcase-visibility";
import { ShowcaseService } from "./showcase.service";

/** At most this many articles of one photo are passed on (the first and the chips «Или: …»). */
const ARTICLES_MAX = 4;
/** At most this many analogs are looked up, each by its own article. */
const ANALOGS_MAX = 6;
/** The longest article text taken from the model. */
const ARTICLE_TEXT_MAX = 40;

/** A share kept within 0…1, two decimals. */
function shareOf(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
}

/**
 * A barcode the model took for an article despite being told not to: 8 or
 * 13 digits with a valid EAN check digit. A real article of the catalog is
 * never one (an article of ten or twelve digits passes — only these two
 * lengths with their check digit are dropped).
 */
export function isEanBarcode(normalized: string): boolean {
  if (!/^\d+$/u.test(normalized) || (normalized.length !== 13 && normalized.length !== 8)) {
    return false;
  }
  const digits = [...normalized].map(Number);
  const check = digits.pop()!;
  const sum = digits
    .reverse()
    .reduce((total, digit, index) => total + digit * (index % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

/**
 * The articles of an answer, as the person will see them (TASK-058): the
 * text trimmed and bounded, only what can be an article of the search
 * (`articleQuery`: long enough and with a digit), no barcode, each normal
 * form once, likeliest first. Whatever else the model said was dropped by
 * the schema; the brand is a hint, never a filter.
 */
export function partArticles(output: PartPhotoOutput): PartPhotoArticle[] {
  if (output.kind !== "article_found") return [];
  const seen = new Set<string>();
  const articles: PartPhotoArticle[] = [];
  const sorted = [...output.articles].sort((a, b) => shareOf(b.confidence) - shareOf(a.confidence));
  for (const candidate of sorted) {
    const text = candidate.text
      .replace(/[^\p{L}\p{N} ./-]+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, ARTICLE_TEXT_MAX);
    const normalized = articleQuery(text);
    if (normalized === null || seen.has(normalized) || isEanBarcode(normalized)) continue;
    seen.add(normalized);
    articles.push({ text, normalized, confidence: shareOf(candidate.confidence) });
    if (articles.length === ARTICLES_MAX) break;
  }
  return articles;
}

/**
 * The digits a letter stands for when a model read a 0 as O or a 1 as I
 * (edge case of TASK-058): tried only when the article as read finds
 * nothing.
 */
export function digitReading(normalized: string): string | null {
  const swapped = normalized.replace(/O/gu, "0").replace(/I/gu, "1");
  return swapped === normalized ? null : swapped;
}

/**
 * A part found by a photo of its article (TASK-058, SCREENS M-CAT-06):
 * through the one way a photo reaches AI (`PhotoRecognitions` — counted
 * with the certificate, stored nowhere), then the article is looked up by
 * the very search of `GET /catalog/search` (`CatalogSearchService`) — the
 * same items, order, marks of compatibility and offers for this city and
 * car — and the analogs of what it found, each by its own article with the
 * same search. A search changes no data: nothing is written, nothing goes
 * to the journal.
 */
@Injectable()
export class PartPhotoService {
  private readonly logger = new Logger("PartPhoto");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(PhotoRecognitions) private readonly photos: PhotoRecognitions,
    @Inject(AiService) private readonly ai: AiService,
    @Inject(CatalogSearchService) private readonly searching: CatalogSearchService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ShowcaseService) private readonly showcase: ShowcaseService,
  ) {}

  async recognize(
    reader: DocumentReader,
    body: Buffer,
    query: PartPhotoQuery,
    viewer: Viewer,
    lang: CatalogLanguage,
  ): Promise<PartPhotoResponse> {
    // The city and the car the search will be for are checked before the
    // attempt is counted and the model paid: a car the directory no longer
    // knows is the search's refusal, never a spent trial (found in review).
    await Promise.all([
      this.showcase.chosenCity(this.database.db, query.cityId, lang),
      this.showcase.vehicle(this.database.db, query),
    ]);
    const reading = await this.photos.read(reader, body, (input, meta) =>
      this.ai.readPartPhoto(input, meta),
    );
    const output = reading.call.output;
    const brandHint = output.brand?.replace(/\s+/gu, " ").trim().slice(0, 60) || null;
    const articles = partArticles(output);
    const nothing = {
      article: null,
      candidates: [],
      brandHint,
      items: [],
      total: 0,
      empty: null,
      analogs: [],
      attempts: reading.attempts,
    };
    if (articles.length === 0) {
      const kind = output.kind === "unreadable" ? "unreadable" : "no_article";
      this.logger.log(`Part photo read result=${kind}`);
      return { kind, ...nothing };
    }

    let [article] = articles as [PartPhotoArticle, ...PartPhotoArticle[]];
    let found = await this.searching.search(this.searchQuery(article.text, query), viewer, lang);
    const digits = found.total === 0 ? digitReading(article.normalized) : null;
    if (digits !== null) {
      const again = await this.searching.search(this.searchQuery(digits, query), viewer, lang);
      if (again.total > 0) {
        article = { ...article, text: digits, normalized: digits };
        found = again;
      }
    }
    const analogs = await this.analogs(found, query, viewer, lang);
    // The kind and how much was found — never the article itself.
    this.logger.log(
      `Part photo read result=article_found articles=${articles.length} items=${found.total} analogs=${analogs.length}`,
    );
    return {
      kind: "article_found",
      article,
      candidates: articles.slice(1),
      brandHint,
      items: found.items,
      total: found.total,
      empty: found.empty,
      analogs,
      attempts: reading.attempts,
    };
  }

  private searchQuery(q: string, query: PartPhotoQuery) {
    const { deviceId: _deviceId, ...rest } = query;
    return { ...rest, q, limit: SHOWCASE_PAGE_DEFAULT_SIZE };
  }

  /**
   * The approved analogs of the items found, each found by its own article
   * with the same search — so an analog shows exactly as it would if the
   * person typed its article: the same offers, the same mark for the car,
   * and nothing a list may not show.
   */
  private async analogs(
    found: CatalogSearchResponse,
    query: PartPhotoQuery,
    viewer: Viewer,
    lang: CatalogLanguage,
  ): Promise<CatalogSearchItem[]> {
    const foundIds = found.items.filter((item) => item.match === "article").map((item) => item.id);
    if (foundIds.length === 0) return [];
    const links = await this.database.db
      .select({ itemId: itemAnalog.itemId, analogItemId: itemAnalog.analogItemId })
      .from(itemAnalog)
      .where(
        and(
          or(inArray(itemAnalog.itemId, foundIds), inArray(itemAnalog.analogItemId, foundIds)),
          eq(itemAnalog.status, "approved"),
        ),
      );
    const known = new Set(found.items.map((item) => item.id));
    const analogIds = [
      ...new Set(links.map((link) => (known.has(link.itemId) ? link.analogItemId : link.itemId))),
    ]
      .filter((id) => !known.has(id))
      .slice(0, ANALOGS_MAX);
    if (analogIds.length === 0) return [];
    const rows = await this.database.db
      .select({ id: catalogItem.id, article: catalogItem.article })
      .from(catalogItem)
      .where(inArray(catalogItem.id, analogIds));
    const result: CatalogSearchItem[] = [];
    for (const row of rows) {
      if (!row.article || articleQuery(row.article) === null) continue;
      const answer = await this.searching.search(
        this.searchQuery(row.article, query),
        viewer,
        lang,
      );
      const item = answer.items.find((entry) => entry.id === row.id);
      if (item) result.push(item);
    }
    // In the order of the links, whatever order the rows came back in.
    return result.sort((a, b) => analogIds.indexOf(a.id) - analogIds.indexOf(b.id));
  }
}
