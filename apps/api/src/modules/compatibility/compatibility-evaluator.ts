import { Inject, Injectable } from "@nestjs/common";
import {
  COMPATIBILITY_CHECK_CATEGORY_PAGE_MAX,
  type CompatibilityCheckBody,
  type CompatibilityCheckResponse,
  type CompatibilityItemResult,
  type CompatibilityLevel,
  type ResolvedCompatibilityVehicle,
} from "@adclub/contracts";
import { sql, type SQL } from "drizzle-orm";
import { DatabaseService, type DbExecutor } from "../../database";
import { decodeCursor, encodeCursor, TIME_POSITION } from "../catalog";
import { resolveVehicle } from "./compatibility-conditions";
import { notFound, validationError } from "./compatibility-errors";
import { itemResultOf } from "./compatibility-rules";

/** Which items a calculation covers. */
export type CompatibilityScope =
  { kind: "items"; itemIds: readonly string[] } | { kind: "category"; categoryId: string };

/**
 * A page of a subcategory (TASK-016): at most `limit` items, newest first,
 * after the position `after` (the time an item was created, to the
 * microsecond, and its id).
 */
export interface CompatibilityPage {
  limit: number;
  after?: { position: string; id: string };
}

interface FactsRow extends Record<string, unknown> {
  item_id: string;
  position: string;
  category_id: string;
  compatibility_required: boolean;
  records: number;
  fits: boolean;
  missing: CompatibilityLevel[] | null;
  viable: boolean;
}

const NO_CAR: ResolvedCompatibilityVehicle = {
  modificationId: null,
  // Never compared: without a car every record is "missing the make", and
  // the rules don't look at the result then.
  makeId: "00000000-0000-0000-0000-000000000000",
  modelId: null,
  generationId: null,
  bodyTypeId: null,
  engineId: null,
  transmissionTypeId: null,
  driveTypeId: null,
  year: null,
  yearFrom: null,
  yearTo: null,
};

/** A list of validated uuids as one array parameter. */
function uuidArray(ids: readonly string[]): SQL {
  return sql`${`{${ids.join(",")}}`}::uuid[]`;
}

/**
 * One level of a record against the car: the record doesn't name it (any
 * car), the car doesn't know it (missing), they agree, or they don't.
 */
function levelConflict(record: SQL, car: string | null): SQL {
  return car === null ? sql`false` : sql`(${record} IS NOT NULL AND ${record} <> ${car}::uuid)`;
}

function levelMissing(record: SQL, car: string | null, level: CompatibilityLevel): SQL {
  return car === null ? sql`CASE WHEN ${record} IS NOT NULL THEN ${level} END` : sql`NULL`;
}

/**
 * The calculation of compatibility (ARCHITECTURE 4.25; TASK-015
 * requirement 4): the only one — the check route now, the client catalog
 * (EPIC-07, EPIC-10) and the garage later call `evaluate`. One SQL
 * statement compares every approved record of every item in the scope
 * with the car and counts, per item, what the records say; the rules of
 * `compatibility-rules.ts` turn that into the result and the display rule.
 * No query per item: a subcategory of thousands of items is one statement.
 *
 * A record against the car, level by level: not named — any car;
 * named and unknown to the car — missing; named and different —
 * contradiction. Years: the car is of a year, or of a range when only its
 * modification or generation is known; a range wholly inside the record's
 * years agrees, wholly outside contradicts, overlapping or unknown is a
 * missing year. A generation the car doesn't know but whose years exclude
 * the car's years contradicts too (a 2019 car isn't of a generation made
 * since 2023). The status of vehicle rows is never looked at: archiving a
 * car doesn't change its results.
 */
@Injectable()
export class CompatibilityEvaluator {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /**
   * The check route: validates the request, resolves the car, evaluates.
   * A subcategory is answered page by page (TASK-016): an open route never
   * answers with an unbounded list.
   */
  async check(body: CompatibilityCheckBody): Promise<CompatibilityCheckResponse> {
    const byIds = body.itemIds !== undefined;
    const byCategory = body.categoryId !== undefined;
    if (byIds === byCategory) {
      throw validationError("itemIds", "Name either itemIds or categoryId, exactly one of them");
    }
    if (byIds && (body.limit !== undefined || body.cursor !== undefined)) {
      throw validationError(
        body.limit !== undefined ? "limit" : "cursor",
        "Pages are only for a whole subcategory (categoryId)",
      );
    }
    const after = body.cursor === undefined ? undefined : decodeCursor(body.cursor);
    if (after && !TIME_POSITION.test(after.position)) {
      throw validationError("cursor", "Use the nextCursor of the previous answer");
    }
    const executor = this.database.db;
    const vehicle = body.vehicle ? await resolveVehicle(executor, body.vehicle) : null;
    if (body.categoryId !== undefined) {
      if (!(await this.visibleSubcategory(executor, body.categoryId))) {
        throw notFound("category");
      }
      const page = await this.evaluatePage(
        vehicle,
        body.categoryId,
        { limit: body.limit ?? COMPATIBILITY_CHECK_CATEGORY_PAGE_MAX, after },
        executor,
      );
      return { vehicle, items: page.items, notFound: [], nextCursor: page.nextCursor };
    }
    const itemIds = [...new Set(body.itemIds)];
    const items = await this.evaluate(vehicle, { kind: "items", itemIds });
    const found = new Set(items.map((item) => item.itemId));
    return {
      vehicle,
      items,
      notFound: itemIds.filter((id) => !found.has(id)),
      nextCursor: null,
    };
  }

  /** One page of a subcategory, newest items first, and the cursor of the next one. */
  async evaluatePage(
    vehicle: ResolvedCompatibilityVehicle | null,
    categoryId: string,
    page: CompatibilityPage,
    executor: DbExecutor = this.database.db,
  ): Promise<{ items: CompatibilityItemResult[]; nextCursor: string | null }> {
    // One more than asked: whether a next page exists, without a count.
    const rows = await this.facts(vehicle, { kind: "category", categoryId }, executor, {
      limit: page.limit + 1,
      after: page.after,
    });
    const more = rows.length > page.limit;
    const shown = more ? rows.slice(0, page.limit) : rows;
    const last = shown.at(-1);
    return {
      items: shown.map(({ result }) => result),
      nextCursor: more && last ? encodeCursor(last.position, last.result.itemId) : null,
    };
  }

  /**
   * The result for every item of the scope a client can see (active, in an
   * active subcategory under an active node), in the order of `itemIds` or,
   * for a subcategory, newest first. `vehicle` `null` — no car chosen.
   */
  async evaluate(
    vehicle: ResolvedCompatibilityVehicle | null,
    scope: CompatibilityScope,
    executor: DbExecutor = this.database.db,
  ): Promise<CompatibilityItemResult[]> {
    const rows = await this.facts(vehicle, scope, executor, undefined);
    const answers = rows.map(({ result }) => result);
    if (scope.kind === "items") {
      const order = new Map(scope.itemIds.map((id, index) => [id, index]));
      answers.sort((a, b) => order.get(a.itemId)! - order.get(b.itemId)!);
    }
    return answers;
  }

  /** The one statement: the result per item of the scope, with each item's position. */
  private async facts(
    vehicle: ResolvedCompatibilityVehicle | null,
    scope: CompatibilityScope,
    executor: DbExecutor,
    page: CompatibilityPage | undefined,
  ): Promise<{ result: CompatibilityItemResult; position: string }[]> {
    if (scope.kind === "items" && scope.itemIds.length === 0) {
      return [];
    }
    const car = vehicle ?? NO_CAR;
    const scopeFilter =
      scope.kind === "items"
        ? sql`i.id = ANY(${uuidArray(scope.itemIds)})`
        : sql`i.category_id = ${scope.categoryId}::uuid`;
    const levels: readonly [SQL, string | null, CompatibilityLevel][] = [
      [sql`r.make_id`, vehicle ? car.makeId : null, "make"],
      [sql`r.model_id`, car.modelId, "model"],
      [sql`r.body_type_id`, car.bodyTypeId, "body"],
      [sql`r.engine_id`, car.engineId, "engine"],
      [sql`r.transmission_type_id`, car.transmissionTypeId, "transmission"],
      [sql`r.drive_type_id`, car.driveTypeId, "drive"],
    ];
    const yearFrom = car.yearFrom;
    const yearTo = car.yearTo;
    const hasYears = sql`(r.year_from IS NOT NULL OR r.year_to IS NOT NULL)`;
    // The car's years: [yearFrom, yearTo], `yearTo` null — still made.
    const carTo = yearTo === null ? sql`NULL::smallint` : sql`${yearTo}::smallint`;
    const yearContained =
      yearFrom === null
        ? sql`false`
        : sql`((r.year_from IS NULL OR ${yearFrom}::smallint >= r.year_from)
            AND (r.year_to IS NULL OR (${carTo} IS NOT NULL AND ${carTo} <= r.year_to)))`;
    const yearDisjoint =
      yearFrom === null
        ? sql`false`
        : sql`((r.year_to IS NOT NULL AND ${yearFrom}::smallint > r.year_to)
            OR (r.year_from IS NOT NULL AND ${carTo} IS NOT NULL AND ${carTo} < r.year_from))`;
    // A generation the car doesn't know, whose years exclude the car's.
    const generationDisjoint =
      yearFrom === null
        ? sql`false`
        : sql`((g.year_to IS NOT NULL AND ${yearFrom}::smallint > g.year_to)
            OR (${carTo} IS NOT NULL AND ${carTo} < g.year_from))`;
    const generationConflict =
      car.generationId === null
        ? sql`(r.generation_id IS NOT NULL AND ${generationDisjoint})`
        : sql`(r.generation_id IS NOT NULL AND r.generation_id <> ${car.generationId}::uuid)`;
    const generationMissing =
      car.generationId === null
        ? sql`CASE WHEN r.generation_id IS NOT NULL THEN 'generation' END`
        : sql`NULL`;
    const conflict = sql.join(
      [
        ...levels.map(([record, value]) => levelConflict(record, value)),
        generationConflict,
        sql`(${hasYears} AND ${yearDisjoint})`,
      ],
      sql` OR `,
    );
    const missing = sql.join(
      [
        levelMissing(sql`r.make_id`, vehicle ? car.makeId : null, "make"),
        levelMissing(sql`r.model_id`, car.modelId, "model"),
        generationMissing,
        ...levels.slice(2).map(([record, value, level]) => levelMissing(record, value, level)),
        sql`CASE WHEN ${hasYears} AND NOT ${yearContained} AND NOT ${yearDisjoint} THEN 'year' END`,
      ],
      sql`, `,
    );
    const afterFilter = page?.after
      ? sql`AND (i.created_at, i.id) < (${page.after.position}::timestamptz, ${page.after.id}::uuid)`
      : sql``;
    const pageLimit = page ? sql`LIMIT ${page.limit}` : sql``;
    const result = await executor.execute<FactsRow>(sql`
      WITH scope AS (
        SELECT i.id, i.category_id, i.created_at, c.compatibility_required,
          to_char(i.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS position
        FROM catalog_item i
        JOIN category c ON c.id = i.category_id
        JOIN category p ON p.id = c.parent_id
        WHERE ${scopeFilter}
          AND i.status = 'active' AND c.status = 'active' AND p.status = 'active'
          ${afterFilter}
        ORDER BY i.created_at DESC, i.id DESC
        ${pageLimit}
      ),
      rec AS (
        SELECT r.item_id,
          (${conflict}) AS conflict,
          array_remove(ARRAY[${missing}]::text[], NULL) AS missing
        FROM item_compatibility r
        JOIN scope s ON s.id = r.item_id
        LEFT JOIN vehicle_generation g ON g.id = r.generation_id
        WHERE r.status = 'approved'
      ),
      per_item AS (
        SELECT item_id,
          count(*)::int AS records,
          bool_or(NOT conflict AND cardinality(missing) = 0) AS fits,
          min(cardinality(missing)) FILTER (WHERE NOT conflict) AS fewest
        FROM rec GROUP BY item_id
      ),
      need AS (
        SELECT rec.item_id, array_agg(DISTINCT level) AS missing
        FROM rec
        JOIN per_item p ON p.item_id = rec.item_id
        CROSS JOIN LATERAL unnest(rec.missing) AS level
        WHERE NOT rec.conflict AND cardinality(rec.missing) = p.fewest AND NOT p.fits
        GROUP BY rec.item_id
      )
      SELECT s.id AS item_id, s.position, s.category_id, s.compatibility_required,
        coalesce(p.records, 0) AS records,
        coalesce(p.fits, false) AS fits,
        p.fewest IS NOT NULL AS viable,
        need.missing
      FROM scope s
      LEFT JOIN per_item p ON p.item_id = s.id
      LEFT JOIN need ON need.item_id = s.id
      ORDER BY s.created_at DESC, s.id DESC
    `);
    return result.rows.map((row) => ({
      position: row.position,
      result: itemResultOf({
        itemId: row.item_id,
        categoryId: row.category_id,
        compatibilityRequired: row.compatibility_required,
        vehicleGiven: vehicle !== null,
        facts: {
          records: Number(row.records),
          fits: row.fits,
          missing: row.viable ? (row.missing ?? []) : null,
        },
      }),
    }));
  }

  private async visibleSubcategory(executor: DbExecutor, categoryId: string): Promise<boolean> {
    const result = await executor.execute<{ id: string }>(sql`
      SELECT c.id FROM category c JOIN category p ON p.id = c.parent_id
      WHERE c.id = ${categoryId}::uuid AND c.status = 'active' AND p.status = 'active'
    `);
    return result.rows.length > 0;
  }
}
