import { Inject, Injectable } from "@nestjs/common";
import type {
  AdminModerationEntry,
  AdminModerationKind,
  AdminModerationPage,
  AdminModerationQuery,
} from "@adclub/contracts";
import { inArray, sql, type SQL } from "drizzle-orm";
import { ApiException } from "../../common/errors";
import { DatabaseService, type DbExecutor } from "../../database";
import { describeAdminProposals, itemCompatibilityProposal } from "../compatibility";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Waiting extends Record<string, unknown> {
  kind: AdminModerationKind;
  id: string;
  /** `created_at` as PostgreSQL prints it — every microsecond, for the cursor. */
  at: string;
}

function encodeCursor(row: Waiting): string {
  return Buffer.from(JSON.stringify([row.at, row.id]), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { at: string; id: string } {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      Array.isArray(value) &&
      typeof value[0] === "string" &&
      typeof value[1] === "string" &&
      UUID.test(value[1]) &&
      !Number.isNaN(Date.parse(value[0]))
    ) {
      return { at: value[0], id: value[1] };
    }
  } catch {
    // Falls through to the refusal.
  }
  throw new ApiException(400, "VALIDATION_ERROR", "Use the nextCursor of the previous page", {
    details: [{ path: "cursor", message: "Use the nextCursor of the previous page" }],
  });
}

/**
 * Every waiting request of suppliers as one table: requests to add an item
 * in `new` (A-MOD-01; from a price list or by hand) and compatibility
 * proposals of suppliers in `pending` (A-MOD-02; an AI proposal is not a
 * supplier's). The tables belong to the price-imports and the compatibility
 * modules; this reads them by name.
 */
function waitingRows(filters: { kind?: AdminModerationKind; supplierId?: string }): SQL {
  const parts: SQL[] = [];
  if (filters.kind !== "compatibility") {
    parts.push(sql`
      SELECT 'item_request'::text AS kind, r.id, r.created_at, r.supplier_id
      FROM catalog_request r
      WHERE r.status = 'new'`);
  }
  if (filters.kind !== "item_request") {
    parts.push(sql`
      SELECT 'compatibility'::text AS kind, p.id, p.created_at, p.supplier_id
      FROM item_compatibility_proposal p
      WHERE p.status = 'pending' AND p.supplier_id IS NOT NULL`);
  }
  const union = sql.join(parts, sql` UNION ALL `);
  return filters.supplierId
    ? sql`SELECT * FROM (${union}) w WHERE w.supplier_id = ${filters.supplierId}::uuid`
    : sql`SELECT * FROM (${union}) w`;
}

/**
 * «Модерация» of the admin panel (TASK-071; SCREENS A-HOME, A-MOD-01,
 * A-MOD-02; ARCHITECTURE 4.89): the queue of everything suppliers wait for.
 * Oldest first; pages by a cursor of (`created_at`, `id`) — a request
 * decided between two pages leaves the queue, a new one comes at its end,
 * and nothing is skipped or repeated. **`count` is the one count of the
 * queue**: the list's «Всего N» and the home card «Модерация ждёт · N».
 * Decisions are made on each one's own card, as before.
 */
@Injectable()
export class ModerationQueueService {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async count(
    filters: { kind?: AdminModerationKind; supplierId?: string } = {},
    executor: DbExecutor = this.database.db,
  ): Promise<number> {
    const result = await executor.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM (${waitingRows(filters)}) q`,
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  async page(query: AdminModerationQuery): Promise<AdminModerationPage> {
    const db = this.database.db;
    const after = query.cursor ? decodeCursor(query.cursor) : null;
    const filters = { kind: query.kind, supplierId: query.supplierId };
    const [rows, total] = await Promise.all([
      db.execute<Waiting>(sql`
        SELECT q.kind, q.id,
               to_char(q.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
        FROM (${waitingRows(filters)}) q
        ${after ? sql`WHERE (q.created_at, q.id) > (${after.at}::timestamptz, ${after.id}::uuid)` : sql``}
        ORDER BY q.created_at, q.id
        LIMIT ${query.limit + 1}`),
      this.count(filters, db),
    ]);
    const page = rows.rows.slice(0, query.limit);
    return {
      entries: await this.describe(db, page),
      total,
      nextCursor: rows.rows.length > query.limit ? encodeCursor(page.at(-1)!) : null,
    };
  }

  private async describe(
    executor: DbExecutor,
    rows: readonly Waiting[],
  ): Promise<AdminModerationEntry[]> {
    const requestIds = rows.filter((row) => row.kind === "item_request").map((row) => row.id);
    const proposalIds = rows.filter((row) => row.kind === "compatibility").map((row) => row.id);
    const [requests, proposals] = await Promise.all([
      requestIds.length === 0
        ? { rows: [] }
        : executor.execute<{
            id: string;
            created_at: Date | string;
            source: "price_import" | "manual";
            name: string | null;
            brand: string | null;
            article: string | null;
            supplier_id: string;
            supplier_name: string | null;
          }>(sql`
            SELECT r.id, r.created_at, r.source,
                   r.payload->>'name' AS name, r.payload->>'brand' AS brand,
                   r.payload->>'article' AS article,
                   r.supplier_id, s.name AS supplier_name
            FROM catalog_request r LEFT JOIN supplier s ON s.id = r.supplier_id
            WHERE ${inArray(sql`r.id`, requestIds)}`),
      proposalIds.length === 0
        ? []
        : executor
            .select()
            .from(itemCompatibilityProposal)
            .where(inArray(itemCompatibilityProposal.id, proposalIds))
            .then((found) => describeAdminProposals(executor, found)),
    ]);
    const requestOf = new Map(requests.rows.map((row) => [row.id, row]));
    const proposalOf = new Map(proposals.map((row) => [row.id, row]));
    return rows.map((row): AdminModerationEntry => {
      if (row.kind === "item_request") {
        const request = requestOf.get(row.id)!;
        return {
          kind: "item_request",
          id: row.id,
          createdAt: new Date(request.created_at).toISOString(),
          supplier: request.supplier_name
            ? { id: request.supplier_id, name: request.supplier_name }
            : null,
          source: request.source,
          proposed: { name: request.name, brand: request.brand, article: request.article },
          item: null,
          vehicle: null,
        };
      }
      const proposal = proposalOf.get(row.id)!;
      const label = proposal.label;
      return {
        kind: "compatibility",
        id: row.id,
        createdAt: proposal.createdAt,
        supplier: proposal.supplier,
        source: "cabinet",
        proposed: null,
        item: {
          id: proposal.item.id,
          name: proposal.item.name,
          brand: proposal.item.brand,
          article: proposal.item.article,
        },
        vehicle: [
          [label.make, label.model].filter(Boolean).join(" "),
          label.generation,
          label.engine,
          label.body,
          label.transmission,
          label.drive,
          label.years,
        ]
          .filter((part): part is string => Boolean(part))
          .join(" · "),
      };
    });
  }
}
