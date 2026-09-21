import { Inject, Injectable } from "@nestjs/common";
import type { CompatibilityConditions } from "@adclub/contracts";
import { normalizeArticle } from "@adclub/domain";
import { sql } from "drizzle-orm";
import { APP_CONFIG, type AppConfig } from "../../config";
import { DatabaseService } from "../../database";
import {
  CompatibilityRecordsService,
  type CompatibilityActor,
} from "./compatibility-records.service";
import { approvedMatch } from "./compatibility-store";

export class DevCompatibilitySeedError extends Error {}

export interface DevCompatibilitySeedResult {
  created: { records: number };
  existing: { records: number };
}

const OPERATOR: CompatibilityActor = { role: "operator" };

const EVIDENCE = "Пример для разработки (TASK-015): черновые данные, не выверены по каталогу";

/**
 * Compatibility of the example items for development and tests (TASK-015
 * requirement 6), on top of the catalog and vehicle seeds (the operator
 * command `dev:compatibility:seed` runs them first; both are idempotent),
 * through the administrator's service:
 * - Geely front pads `04465-0K090` — Geely Atlas, second generation;
 * - their analog TRW `GDB3534` — copied from them in one action;
 * - the oil «Shell Helix HX8 5W-30, 4 л» — Geely Coolray with the engine
 *   JLH-3G15TD (a record that needs the engine; engine oils are a
 *   universal subcategory);
 * - Geely rear pads `4050068800` — no records, in a subcategory with
 *   compulsory compatibility (hidden when a car is chosen).
 * What exists is left as it is: a second run creates nothing.
 */
@Injectable()
export class DevCompatibilitySeed {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(CompatibilityRecordsService) private readonly records: CompatibilityRecordsService,
  ) {}

  async run(): Promise<DevCompatibilitySeedResult> {
    if (this.config.nodeEnv !== "development" && this.config.nodeEnv !== "test") {
      throw new DevCompatibilitySeedError(
        "Compatibility is kept by the administrator; the example data is for development and tests only",
      );
    }
    const result: DevCompatibilitySeedResult = {
      created: { records: 0 },
      existing: { records: 0 },
    };

    const geely = await this.one(
      "the make Geely",
      sql`SELECT make_id AS id FROM vehicle_make_spelling WHERE key = 'geely'`,
    );
    const atlas = await this.one(
      "the model Atlas",
      sql`SELECT model_id AS id FROM vehicle_model_spelling WHERE make_id = ${geely}::uuid AND key = 'atlas'`,
    );
    const atlasII = await this.one(
      "the generation Atlas II",
      sql`SELECT id FROM vehicle_generation WHERE model_id = ${atlas}::uuid AND name_key = 'ii (fx11)'`,
    );
    const coolray = await this.one(
      "the model Coolray",
      sql`SELECT model_id AS id FROM vehicle_model_spelling WHERE make_id = ${geely}::uuid AND key = 'coolray'`,
    );
    const engine = await this.one(
      "the engine JLH-3G15TD",
      sql`SELECT engine_id AS id FROM vehicle_engine_spelling WHERE key = 'jlh-3g15td'`,
    );
    const frontPads = await this.part("Geely", "04465-0K090");
    const trwPads = await this.part("TRW", "GDB3534");
    const oil = await this.one(
      "the oil «Shell Helix HX8 5W-30, 4 л»",
      sql`SELECT entity_id AS id FROM translation
          WHERE entity_type = 'catalog_item' AND field = 'name' AND lang = 'ru'
            AND text = 'Shell Helix HX8 5W-30, 4 л'`,
    );

    const none = {
      modelId: null,
      generationId: null,
      bodyTypeId: null,
      engineId: null,
      transmissionTypeId: null,
      driveTypeId: null,
      yearFrom: null,
      yearTo: null,
    };
    const wanted: [string, CompatibilityConditions][] = [
      [frontPads, { ...none, makeId: geely, modelId: atlas, generationId: atlasII }],
      [oil, { ...none, makeId: geely, modelId: coolray, engineId: engine }],
    ];
    for (const [itemId, conditions] of wanted) {
      if (await approvedMatch(this.database.db, itemId, conditions)) {
        result.existing.records += 1;
        continue;
      }
      await this.records.create(itemId, { conditions, evidence: EVIDENCE }, OPERATOR);
      result.created.records += 1;
    }
    const copied = await this.records.copyFromAnalog(trwPads, frontPads, OPERATOR);
    result.created.records += copied.created;
    result.existing.records += copied.alreadyPresent;
    return result;
  }

  private async part(brand: string, article: string): Promise<string> {
    return this.one(
      `the part ${brand} ${article}`,
      sql`SELECT i.id FROM catalog_item i JOIN brand_spelling b ON b.brand_id = i.brand_id
          WHERE b.key = ${brand.toLowerCase()} AND i.article_norm = ${normalizeArticle(article)}`,
    );
  }

  private async one(what: string, query: ReturnType<typeof sql>): Promise<string> {
    const result = await this.database.db.execute<{ id: string }>(query);
    const id = result.rows[0]?.id;
    if (!id) {
      throw new DevCompatibilitySeedError(
        `The seed can't find ${what}: fill the catalog and the vehicle catalog first`,
      );
    }
    return id;
  }
}
