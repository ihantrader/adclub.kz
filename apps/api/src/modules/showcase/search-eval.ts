import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Inject, Injectable } from "@nestjs/common";
import { catalogSearchQuerySchema, type CatalogSearchResponse } from "@adclub/contracts";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { DatabaseService } from "../../database";
import { CatalogSearchService } from "./catalog-search.service";

/**
 * The measured quality of the users' search (TASK-045 requirement 4;
 * ARCHITECTURE 4.65): a set of phrases over the development catalog
 * (`search-eval/phrases.json` at the root of the repository, data in the
 * repository) — articles in several spellings, the wrong layout,
 * transliteration, typos of one and two letters, synonyms in kk/ru/en,
 * mixed languages, and phrases that must find nothing. A phrase passes when
 * one of the items it expects is among the first three results (or, for
 * «nothing», when nothing is found). The integration test runs it on a real
 * Meilisearch; `operator search:eval` — on the development database, for
 * changes of synonyms.
 */

const carSchema = z.object({
  make: z.string(),
  model: z.string(),
  year: z.number().int().optional(),
});

const phraseSchema = z.object({
  q: z.string(),
  /**
   * The items any of which must be among the first three: a part by
   * «<brand> <article>», anything else by its Russian name. Empty — the
   * phrase must find nothing.
   */
  expect: z.array(z.string()),
  /** What the phrase tries: article, layout, translit, typo, synonym, kazakh, english, mixed, name, nothing. */
  kind: z.string(),
  car: carSchema.optional(),
  /** A city code; `null` — «весь Казахстан»; left out — the set's city. */
  city: z.string().nullable().optional(),
});

export const searchEvalSetSchema = z.object({
  version: z.number().int(),
  /** The city the phrases are searched in unless they say otherwise. */
  city: z.string(),
  /** How many first results a phrase may find its item among. */
  top: z.number().int().min(1),
  /** The share of phrases that must pass. */
  threshold: z.number().min(0).max(1),
  phrases: z.array(phraseSchema).min(1),
});

export type SearchEvalSet = z.infer<typeof searchEvalSetSchema>;
export type SearchEvalPhrase = z.infer<typeof phraseSchema>;

export interface SearchEvalFailure {
  q: string;
  kind: string;
  expected: string[];
  /** The first results, by the same keys («<brand> <article>» or the Russian name). */
  got: string[];
  total: number;
}

export interface SearchEvalResult {
  phrases: number;
  passed: number;
  share: number;
  threshold: number;
  ok: boolean;
  /** By kind: passed of all. */
  byKind: Record<string, { passed: number; phrases: number }>;
  failures: SearchEvalFailure[];
}

/** `search-eval/phrases.json`, found from this file upwards (the repository root). */
export function loadSearchEvalSet(): SearchEvalSet {
  let directory = __dirname;
  for (let depth = 0; depth < 10; depth += 1) {
    try {
      readFileSync(join(directory, "pnpm-workspace.yaml"));
      return searchEvalSetSchema.parse(
        JSON.parse(readFileSync(join(directory, "search-eval", "phrases.json"), "utf8")),
      );
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError) {
        throw error;
      }
      const parent = dirname(directory);
      if (parent === directory) {
        break;
      }
      directory = parent;
    }
  }
  throw new Error("search-eval/phrases.json was not found above this file");
}

@Injectable()
export class SearchEval {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(CatalogSearchService) private readonly search: CatalogSearchService,
  ) {}

  /** Runs every phrase of the set as a guest, in Russian. */
  async run(set: SearchEvalSet = loadSearchEvalSet()): Promise<SearchEvalResult> {
    const keys = await this.itemKeys();
    const keyOf = (id: string) => keys.get(id) ?? id;
    const failures: SearchEvalFailure[] = [];
    const byKind: SearchEvalResult["byKind"] = {};
    let passed = 0;
    for (const phrase of set.phrases) {
      const answer = await this.ask(phrase, set);
      const top = answer.items.slice(0, set.top).map((item) => keyOf(item.id));
      const ok =
        phrase.expect.length === 0
          ? answer.total === 0
          : phrase.expect.some((expected) => top.includes(expected));
      const kind = (byKind[phrase.kind] ??= { passed: 0, phrases: 0 });
      kind.phrases += 1;
      if (ok) {
        passed += 1;
        kind.passed += 1;
      } else {
        failures.push({
          q: phrase.q,
          kind: phrase.kind,
          expected: phrase.expect,
          got: top,
          total: answer.total,
        });
      }
    }
    const share = passed / set.phrases.length;
    return {
      phrases: set.phrases.length,
      passed,
      share: Math.round(share * 1000) / 1000,
      threshold: set.threshold,
      ok: share >= set.threshold,
      byKind,
      failures,
    };
  }

  private async ask(phrase: SearchEvalPhrase, set: SearchEvalSet): Promise<CatalogSearchResponse> {
    const cityCode = phrase.city === undefined ? set.city : phrase.city;
    const params: Record<string, unknown> = { q: phrase.q, limit: 10 };
    if (cityCode !== null) {
      const city = await this.database.db.execute<{ id: string }>(
        sql`SELECT id FROM city WHERE code = ${cityCode} AND status = 'active'`,
      );
      if (city.rows[0]) {
        params.cityId = city.rows[0].id;
      }
    }
    if (phrase.car) {
      const car = await this.database.db.execute<{ make_id: string; model_id: string }>(sql`
        SELECT mk.id AS make_id, md.id AS model_id
        FROM vehicle_make mk
        JOIN vehicle_make_spelling ms ON ms.make_id = mk.id AND ms.is_name
        JOIN vehicle_model md ON md.make_id = mk.id
        JOIN vehicle_model_spelling ds ON ds.model_id = md.id AND ds.is_name
        WHERE lower(ms.text) = lower(${phrase.car.make}) AND lower(ds.text) = lower(${phrase.car.model})
      `);
      if (!car.rows[0]) {
        throw new Error(`The car ${phrase.car.make} ${phrase.car.model} is not in the catalog`);
      }
      params.vehicleMakeId = car.rows[0].make_id;
      params.vehicleModelId = car.rows[0].model_id;
      if (phrase.car.year !== undefined) {
        params.vehicleYear = phrase.car.year;
      }
    }
    return this.search.search(
      catalogSearchQuerySchema.parse(params),
      { accountId: null, clubAccess: false },
      "ru",
    );
  }

  /** «<brand> <article>» of a part, the Russian name of anything else — by item id. */
  private async itemKeys(): Promise<Map<string, string>> {
    const rows = await this.database.db.execute<{
      id: string;
      article: string | null;
      brand: string | null;
      name: string | null;
    }>(sql`
      SELECT i.id, i.article, b.text AS brand, t.text AS name
      FROM catalog_item i
      LEFT JOIN brand_spelling b ON b.brand_id = i.brand_id AND b.is_name
      LEFT JOIN translation t ON t.entity_type = 'catalog_item' AND t.field = 'name'
        AND t.lang = 'ru' AND t.entity_id = i.id
    `);
    return new Map(
      rows.rows.map((row) => [
        row.id,
        row.article && row.brand ? `${row.brand} ${row.article}` : (row.name ?? row.id),
      ]),
    );
  }
}
