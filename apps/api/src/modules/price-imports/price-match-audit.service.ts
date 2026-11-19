import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  auditActions,
  auditEntities,
  type AdminPriceMatchAudit,
  type CatalogLanguage,
  type PriceMatchAuditCard,
  type PriceMatchAuditConflictDetails,
  type PriceMatchAuditCorrectBody,
  type PriceMatchAuditListQuery,
  type PriceMatchAuditMetrics,
  type PriceMatchAuditMetricsQuery,
  type PriceMatchAuditPage,
  type PriceMatchAuditResult as PriceMatchAuditResultView,
  type PriceMatchAuditWrongBody,
  type SupplierMatchCorrectionPage,
  type SupplierMatchCorrectionQuery,
} from "@adclub/contracts";
import {
  activeOrderStatuses,
  PRICE_AUDIT_BUCKETS,
  priceAuditBucket,
  priceAuditOfferVerdict,
  type PriceAuditBucket,
  type PriceAuditOfferFacts,
} from "@adclub/domain";
import { and, asc, count, desc, eq, getTableColumns, inArray, sql, type SQL } from "drizzle-orm";
import { ApiException } from "../../common/errors";
import { DatabaseService, type DbExecutor } from "../../database";
import { aiJob } from "../ai";
import { AuditLog } from "../audit";
import { CatalogPhotosService, type CatalogActor } from "../catalog";
import { adminUser, supplier, supplierMember } from "../identity";
import { describeOfferItems } from "../offers";
import { AppSettings } from "../settings";
import { moderationSeenAt } from "./moderation-seen";
import { validationError } from "./price-import-errors";
import { itemsByIds } from "./price-match-items";
import {
  priceImport,
  priceImportRow,
  priceMatchAudit,
  type PriceMatchAuditRecord,
  type PriceMatchAuditResult,
  type StoredCandidate,
} from "./schema";

type AdminActor = Extract<CatalogActor, { role: "admin" }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encodeCursor(at: string, id: string): string {
  return Buffer.from(JSON.stringify([at, id]), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { at: string; id: string } {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      Array.isArray(value) &&
      typeof value[0] === "string" &&
      typeof value[1] === "string" &&
      UUID.test(value[1]) &&
      new Date(value[0]).toISOString() === value[0]
    ) {
      return { at: value[0], id: value[1] };
    }
  } catch {
    // Falls through to the refusal.
  }
  throw validationError("cursor", "Use the nextCursor of the previous page");
}

/**
 * A moment of the cursor: the column cut to milliseconds — a JS `Date` keeps
 * no more, while `now()` has microseconds and every row put aside by one
 * application shares it. Ordered, compared and encoded by the same value.
 */
function cursorMoment(column: typeof priceMatchAudit.createdAt | typeof priceMatchAudit.decidedAt) {
  return sql`date_trunc('milliseconds', ${column})`;
}

function cursorText(column: typeof priceMatchAudit.createdAt | typeof priceMatchAudit.decidedAt) {
  return sql<string>`to_char(date_trunc('milliseconds', ${column}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

/** The confidence bucket as SQL bounds (the domain's buckets: from inclusive, to exclusive). */
function bucketFilter(bucket: PriceAuditBucket): SQL {
  const index = PRICE_AUDIT_BUCKETS.findIndex((entry) => entry.id === bucket);
  const entry = PRICE_AUDIT_BUCKETS[index]!;
  const lower =
    index === 0 ? undefined : sql`${priceMatchAudit.aiConfidence} >= ${String(entry.from)}`;
  const upper =
    entry.to === null ? undefined : sql`${priceMatchAudit.aiConfidence} < ${String(entry.to)}`;
  return and(lower, upper) ?? sql`true`;
}

function share(part: number, whole: number): number | null {
  return whole === 0 ? null : Math.round((part / whole) * 1000) / 1000;
}

function resultView(result: PriceMatchAuditResult | null): PriceMatchAuditResultView | null {
  if (!result) return null;
  return result.offer.withdrawn
    ? {
        memoryRemoved: result.memoryRemoved,
        offerId: result.offer.id,
        offerWithdrawn: true,
        keepReason: null,
        activeOrders: 0,
      }
    : {
        memoryRemoved: result.memoryRemoved,
        offerId: result.offer.id,
        offerWithdrawn: false,
        keepReason: result.offer.reason,
        activeOrders: result.offer.activeOrders,
      };
}

/**
 * How long «Неверно» waits for the offer and the memory held by an
 * application of a price list (TASK-065.A): well inside the statement's
 * limit, then «Поставщик сейчас применяет прайс» instead of a 500.
 */
const WRONG_LOCK_TIMEOUT_MS = 1000;

/** The lock wait of a statement ran out (`55P03`, `lock_not_available`). */
function lockNotAvailable(error: unknown): boolean {
  for (let current: unknown = error; current; current = (current as { cause?: unknown }).cause) {
    if ((current as { code?: unknown }).code === "55P03") return true;
    if (current === (current as { cause?: unknown }).cause) break;
  }
  return false;
}

interface OfferFacts extends PriceAuditOfferFacts {
  id: string;
  price: number;
}

/**
 * The administrator's spot check of AI matches of price lists (TASK-065;
 * D-075; SCREENS A-MOD-04; ARCHITECTURE 4.94). The rows are put aside by the
 * application of a price list (`PriceImportApplier`); here an administrator
 * says «Верно» or «Неверно», and «Неверно» removes the company's memory of
 * the row and withdraws the offer on the wrong item by
 * `priceAuditOfferVerdict` of the domain. One count of the queue for the
 * list and the home card (`waiting`).
 */
@Injectable()
export class PriceMatchAuditService {
  private readonly logger = new Logger("PriceMatchAudit");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditLog) private readonly audit: AuditLog,
    @Inject(CatalogPhotosService) private readonly photos: CatalogPhotosService,
    @Inject(AppSettings) private readonly settings: AppSettings,
  ) {}

  /** «Аудит сопоставлений ждёт · N»: the `total` of the queue without filters. */
  async waiting(): Promise<number> {
    const [row] = await this.database.db
      .select({ value: count() })
      .from(priceMatchAudit)
      .where(eq(priceMatchAudit.status, "pending"));
    return row?.value ?? 0;
  }

  async page(query: PriceMatchAuditListQuery, lang: CatalogLanguage): Promise<PriceMatchAuditPage> {
    const db = this.database.db;
    const after = query.cursor ? decodeCursor(query.cursor) : null;
    const others: (SQL | undefined)[] = [
      query.supplierId ? eq(priceMatchAudit.supplierId, query.supplierId) : undefined,
      query.bucket ? bucketFilter(query.bucket) : undefined,
    ];
    const filters = [...others, eq(priceMatchAudit.status, query.status)];
    const pending = query.status === "pending";
    // The queue: oldest first. Decided: the latest decision first.
    const moment = pending
      ? cursorMoment(priceMatchAudit.createdAt)
      : cursorMoment(priceMatchAudit.decidedAt);
    const order = pending
      ? [asc(moment), asc(priceMatchAudit.id)]
      : [desc(moment), desc(priceMatchAudit.id)];
    const cursorFilter = after
      ? pending
        ? sql`(${moment}, ${priceMatchAudit.id}) > (${after.at}::timestamptz, ${after.id}::uuid)`
        : sql`(${moment}, ${priceMatchAudit.id}) < (${after.at}::timestamptz, ${after.id}::uuid)`
      : undefined;
    const [rows, [total], statuses] = await Promise.all([
      db
        .select({
          ...getTableColumns(priceMatchAudit),
          cursorAt: pending
            ? cursorText(priceMatchAudit.createdAt)
            : cursorText(priceMatchAudit.decidedAt),
        })
        .from(priceMatchAudit)
        .where(and(...filters, cursorFilter))
        .orderBy(...order)
        .limit(query.limit + 1),
      db
        .select({ value: count() })
        .from(priceMatchAudit)
        .where(and(...filters)),
      db
        .select({ status: priceMatchAudit.status, value: count() })
        .from(priceMatchAudit)
        .where(and(...others))
        .groupBy(priceMatchAudit.status),
    ]);
    const page = rows.slice(0, query.limit);
    const counts = { pending: 0, correct: 0, wrong: 0 };
    for (const row of statuses) counts[row.status] = row.value;
    const last = page.at(-1);
    return {
      audits: (await this.describe(db, page, lang)).map((entry) => entry.audit),
      total: total?.value ?? 0,
      counts,
      nextCursor: rows.length > query.limit && last ? encodeCursor(last.cursorAt, last.id) : null,
    };
  }

  async card(auditId: string, lang: CatalogLanguage): Promise<PriceMatchAuditCard> {
    const db = this.database.db;
    return this.cardOf(db, await this.find(db, auditId), lang);
  }

  /** «Верно»: the row is closed, nothing else changes. */
  async correct(
    auditId: string,
    body: PriceMatchAuditCorrectBody,
    actor: AdminActor,
    lang: CatalogLanguage,
  ): Promise<PriceMatchAuditCard> {
    await this.database.db.transaction(async (tx) => {
      const row = await this.assertPending(tx, auditId, body.expectedVersion);
      await tx
        .update(priceMatchAudit)
        .set({
          status: "correct",
          decidedByAdminId: actor.adminId,
          decidedAt: sql`now()`,
          version: row.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(priceMatchAudit.id, auditId));
      await this.audit.record(
        {
          action: auditActions.priceMatchAuditCorrect,
          actor,
          entityType: auditEntities.priceMatchAudit,
          entityId: auditId,
          before: { status: "pending" },
          after: {
            status: "correct",
            supplierId: row.supplierId,
            importId: row.importId,
            rowNo: row.rowNo,
            itemId: row.aiItemId,
          },
        },
        tx,
      );
    });
    const db = this.database.db;
    return this.cardOf(db, await this.find(db, auditId), lang);
  }

  /**
   * «Неверно» (D-075): in one transaction the company's memory of the row's
   * key is removed (only while it still names the wrong item — a later
   * «Другая позиция» of the supplier stays), and the offer the row made or
   * changed is withdrawn with `match_corrected` when the domain says so.
   * No offer on the right item is made: the supplier sets it by the next
   * price list or by hand.
   */
  async wrong(
    auditId: string,
    body: PriceMatchAuditWrongBody,
    actor: AdminActor,
    lang: CatalogLanguage,
  ): Promise<PriceMatchAuditCard> {
    if ((body.correctItemId === null) === !body.notInCatalog) {
      throw validationError(
        "correctItemId",
        "Choose the right item, or say there is no such item in the catalog — one of them",
      );
    }
    try {
      await this.database.db.transaction(async (tx) => {
        // An application of the supplier's price list holds its offers (and
        // then the memory) for as long as it runs: wait a little, not forever.
        await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${String(WRONG_LOCK_TIMEOUT_MS)}ms'`));
        await this.markWrong(tx, auditId, body, actor);
      });
    } catch (error) {
      if (!lockNotAvailable(error)) throw error;
      throw new ApiException(
        409,
        "PRICE_MATCH_AUDIT_BUSY",
        "The supplier is applying a price list right now; try again in a minute",
        { retryable: true },
      );
    }
    this.logger.log(`AI match marked wrong audit=${auditId}`);
    const db = this.database.db;
    return this.cardOf(db, await this.find(db, auditId), lang);
  }

  private async markWrong(
    tx: DbExecutor,
    auditId: string,
    body: PriceMatchAuditWrongBody,
    actor: AdminActor,
  ): Promise<void> {
    const row = await this.assertPending(tx, auditId, body.expectedVersion);
    if (body.correctItemId !== null) {
      if (body.correctItemId === row.aiItemId) {
        throw validationError("correctItemId", "This is the item AI chose; press «Верно»");
      }
      const item = (await itemsByIds(tx, [body.correctItemId])).get(body.correctItemId);
      if (!item || !item.available || item.itemType === "service") {
        throw validationError(
          "correctItemId",
          "Choose an active part or product of a visible subcategory",
        );
      }
    }
    // The offer first, as the application of a price list locks offers before memory;
    // an order placed while this waited is seen by the count below (its own statement).
    if (row.offerId) {
      await tx.execute(sql`SELECT id FROM offer WHERE id = ${row.offerId} FOR UPDATE`);
    }
    const [source] = await tx
      .select({ keyKind: priceImportRow.matchKeyKind, key: priceImportRow.matchKey })
      .from(priceImportRow)
      .where(and(eq(priceImportRow.importId, row.importId), eq(priceImportRow.rowNo, row.rowNo)));
    const removed =
      source?.keyKind && source.key
        ? await tx.execute(sql`
            DELETE FROM supplier_sku_mapping
            WHERE supplier_id = ${row.supplierId} AND key_kind = ${source.keyKind}
              AND key = ${source.key} AND decision = 'item' AND item_id = ${row.aiItemId}
            RETURNING id`)
        : { rows: [] };
    const facts = row.offerId ? await this.offerFacts(tx, row) : null;
    const verdict = priceAuditOfferVerdict(facts);
    const result: PriceMatchAuditResult = {
      memoryRemoved: removed.rows.length > 0,
      offer: verdict.withdraw
        ? { id: facts!.id, withdrawn: true }
        : {
            id: facts?.id ?? null,
            withdrawn: false,
            reason: verdict.reason,
            activeOrders: facts?.activeOrders ?? 0,
          },
    };
    if (verdict.withdraw) {
      const done = await tx.execute<{ version: number }>(sql`
        UPDATE offer
        SET status = 'withdrawn', withdrawn_at = now(), withdrawn_reason = 'match_corrected',
            version = version + 1, updated_at = now()
        WHERE id = ${facts!.id} AND status = 'active'
        RETURNING version`);
      await this.audit.record(
        {
          action: auditActions.offerWithdrawn,
          actor,
          entityType: auditEntities.offer,
          entityId: facts!.id,
          before: { status: "active" },
          after: {
            status: "withdrawn",
            reason: "match_corrected",
            version: done.rows[0]?.version ?? null,
            auditId,
          },
        },
        tx,
      );
    }
    await tx
      .update(priceMatchAudit)
      .set({
        status: "wrong",
        correctItemId: body.correctItemId,
        notInCatalog: body.notInCatalog,
        comment: body.comment ?? null,
        result,
        decidedByAdminId: actor.adminId,
        // The database's clock, as «Модерация» compares it (`moderation_seen_at`).
        decidedAt: sql`now()`,
        version: row.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(priceMatchAudit.id, auditId));
    const view = resultView(result)!;
    await this.audit.record(
      {
        action: auditActions.priceMatchAuditWrong,
        actor,
        entityType: auditEntities.priceMatchAudit,
        entityId: auditId,
        before: { status: "pending" },
        after: {
          status: "wrong",
          supplierId: row.supplierId,
          importId: row.importId,
          rowNo: row.rowNo,
          itemId: row.aiItemId,
          correctItemId: body.correctItemId,
          notInCatalog: body.notInCatalog,
          memoryRemoved: view.memoryRemoved,
          offerId: view.offerId,
          offerWithdrawn: view.offerWithdrawn,
          keepReason: view.keepReason,
        },
        ...(body.comment ? { reason: body.comment } : {}),
      },
      tx,
    );
  }

  /**
   * The accuracy of a period: the checks decided in it by bucket (the
   * domain's `priceAuditBucket`), and of the rows AI proposed in price lists
   * applied in it, how many the suppliers accepted.
   */
  async metrics(query: PriceMatchAuditMetricsQuery): Promise<PriceMatchAuditMetrics> {
    const db = this.database.db;
    const days = Number(query.days);
    const bounds = await db.execute<{ from: string; to: string }>(sql`
      SELECT to_char((now() - make_interval(days => ${days})) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS from,
        to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS to`);
    const { from, to } = bounds.rows[0]!;
    const [checks, proposals, threshold] = await Promise.all([
      db.execute<{ confidence: string; status: "correct" | "wrong"; value: number }>(sql`
        SELECT ai_confidence AS confidence, status, count(*)::int AS value
        FROM price_match_audit
        WHERE status <> 'pending' AND decided_at >= ${from}::timestamptz
        GROUP BY ai_confidence, status`),
      // Counted per import when it was applied (TASK-065.A): the period adds
      // imports up, whatever the size of their price lists.
      db.execute<{ proposed: number; accepted: number }>(sql`
        SELECT coalesce(sum(ai_proposed_rows), 0)::int AS proposed,
          coalesce(sum(ai_accepted_rows), 0)::int AS accepted
        FROM price_import
        WHERE status = 'applied' AND applied_at >= ${from}::timestamptz`),
      this.settings.get("price_match_confidence_threshold"),
    ]);
    const buckets = new Map(
      PRICE_AUDIT_BUCKETS.map((bucket) => [bucket.id, { checked: 0, correct: 0 }]),
    );
    let checked = 0;
    let correct = 0;
    for (const row of checks.rows) {
      const entry = buckets.get(priceAuditBucket(Number(row.confidence)))!;
      entry.checked += row.value;
      checked += row.value;
      if (row.status === "correct") {
        entry.correct += row.value;
        correct += row.value;
      }
    }
    const proposed = proposals.rows[0]?.proposed ?? 0;
    const accepted = proposals.rows[0]?.accepted ?? 0;
    return {
      days,
      from,
      to,
      checked,
      correct,
      accuracy: share(correct, checked),
      buckets: PRICE_AUDIT_BUCKETS.map((bucket) => {
        const entry = buckets.get(bucket.id)!;
        return {
          bucket: bucket.id,
          from: bucket.from,
          to: bucket.to,
          checked: entry.checked,
          correct: entry.correct,
          accuracy: share(entry.correct, entry.checked),
        };
      }),
      proposals: { proposed, accepted, acceptedShare: share(accepted, proposed) },
      threshold,
    };
  }

  /** The company's corrected matches (S-MOD-01), latest first, with «новое» for this employee. */
  async supplierCorrections(
    actor: { supplierId: string; memberId: string },
    query: SupplierMatchCorrectionQuery,
    lang: CatalogLanguage,
  ): Promise<SupplierMatchCorrectionPage> {
    const db = this.database.db;
    const after = query.cursor ? decodeCursor(query.cursor) : null;
    const filters = [
      eq(priceMatchAudit.supplierId, actor.supplierId),
      eq(priceMatchAudit.status, "wrong"),
    ];
    const [rows, [total], seenAt] = await Promise.all([
      db
        .select({
          ...getTableColumns(priceMatchAudit),
          cursorAt: cursorText(priceMatchAudit.decidedAt),
        })
        .from(priceMatchAudit)
        .where(
          and(
            ...filters,
            after
              ? sql`(${cursorMoment(priceMatchAudit.decidedAt)}, ${priceMatchAudit.id}) < (${after.at}::timestamptz, ${after.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(cursorMoment(priceMatchAudit.decidedAt)), desc(priceMatchAudit.id))
        .limit(query.limit + 1),
      db
        .select({ value: count() })
        .from(priceMatchAudit)
        .where(and(...filters)),
      moderationSeenAt(db, actor.memberId),
    ]);
    const page = rows.slice(0, query.limit);
    const described = await this.describe(db, page, lang);
    const last = page.at(-1);
    return {
      entries: described.map(({ audit, record }) => ({
        id: audit.id,
        row: audit.row,
        importId: audit.import.id,
        wrongItem: audit.aiItem,
        correctItem: audit.correctItem,
        notInCatalog: audit.notInCatalog,
        offerWithdrawn: audit.result?.offerWithdrawn ?? false,
        keepReason: audit.result?.keepReason ?? null,
        decidedAt: audit.decidedAt!,
        isNew: record.decidedAt !== null && record.decidedAt > seenAt,
      })),
      total: total?.value ?? 0,
      nextCursor: rows.length > query.limit && last ? encodeCursor(last.cursorAt, last.id) : null,
    };
  }

  // ------------------------------------------------------------------ internals

  private async cardOf(
    executor: DbExecutor,
    record: PriceMatchAuditRecord,
    lang: CatalogLanguage,
  ): Promise<PriceMatchAuditCard> {
    const [[described], facts] = await Promise.all([
      this.describe(executor, [record], lang),
      record.offerId ? this.offerFacts(executor, record) : Promise.resolve(null),
    ]);
    const verdict = priceAuditOfferVerdict(facts);
    const [row] = await executor
      .select({ candidates: priceImportRow.candidates })
      .from(priceImportRow)
      .where(
        and(eq(priceImportRow.importId, record.importId), eq(priceImportRow.rowNo, record.rowNo)),
      );
    const others = (row?.candidates ?? [])
      .map((candidate: StoredCandidate) => candidate.itemId)
      .filter((id) => id !== record.aiItemId);
    const items = await describeOfferItems(executor, this.photos, others, lang);
    return {
      audit: described!.audit,
      offer: facts
        ? {
            id: facts.id,
            status: facts.status,
            price: facts.price,
            activeOrders: facts.activeOrders,
            editedByHand: facts.editedByHand,
            willWithdraw: verdict.withdraw,
            keepReason: verdict.withdraw ? null : verdict.reason,
          }
        : null,
      candidates: others.flatMap((id) => {
        const item = items.get(id);
        return item ? [item] : [];
      }),
    };
  }

  /**
   * The offer the row made or changed, now: its status, its active orders,
   * and whether anyone changed it by hand since the row was applied — an
   * entry of the journal about it after the row was put aside that did not
   * come from a price list.
   */
  private async offerFacts(
    executor: DbExecutor,
    record: PriceMatchAuditRecord,
  ): Promise<OfferFacts | null> {
    const statuses = sql.join(
      activeOrderStatuses.map((status) => sql`${status}`),
      sql`, `,
    );
    const rows = await executor.execute<{
      id: string;
      status: "active" | "withdrawn" | "suspended";
      price: number;
      active_orders: number;
      edited: boolean;
      by_import: boolean;
    }>(sql`
      SELECT o.id, o.status, o.price, o.created_import_id IS NOT NULL AS by_import,
        (SELECT count(*)::int FROM customer_order co
          WHERE co.offer_id = o.id AND co.supplier_id = o.supplier_id
            AND co.status IN (${statuses})) AS active_orders,
        EXISTS (
          SELECT 1 FROM audit_log l
          WHERE l.entity_type = 'offer' AND l.entity_id = o.id::text
            AND l.created_at > ${record.createdAt}
            AND l.action LIKE 'offer.%'
            AND coalesce(l.after->>'source', '') <> 'price_import'
            -- The withdrawal by this very check is not a hand edit.
            AND NOT coalesce(l.after ? 'auditId', false)
        ) AS edited
      FROM offer o
      WHERE o.id = ${record.offerId} AND o.supplier_id = ${record.supplierId}`);
    const row = rows.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      status: row.status,
      price: row.price,
      activeOrders: row.active_orders,
      editedByHand: row.edited,
      rowOutcome: record.rowOutcome,
      createdByImport: row.by_import,
    };
  }

  private async assertPending(
    executor: DbExecutor,
    auditId: string,
    expectedVersion: number,
  ): Promise<PriceMatchAuditRecord> {
    const [row] = await executor
      .select()
      .from(priceMatchAudit)
      .where(eq(priceMatchAudit.id, auditId))
      .for("update");
    if (!row) throw new ApiException(404, "NOT_FOUND", "No such row");
    if (row.status !== "pending" || row.version !== expectedVersion) {
      const details: PriceMatchAuditConflictDetails = {
        status: row.status,
        version: row.version,
        decidedBy: row.decidedByAdminId
          ? {
              adminId: row.decidedByAdminId,
              name:
                (await this.adminNames(executor, [row.decidedByAdminId])).get(
                  row.decidedByAdminId,
                ) ?? null,
            }
          : null,
        decidedAt: row.decidedAt?.toISOString() ?? null,
      };
      throw new ApiException(
        409,
        "PRICE_MATCH_AUDIT_CONFLICT",
        row.status === "pending"
          ? "The row was changed by someone else meanwhile; reload it"
          : "The row has been checked already",
        { details },
      );
    }
    return row;
  }

  private async find(executor: DbExecutor, auditId: string): Promise<PriceMatchAuditRecord> {
    const [row] = await executor
      .select()
      .from(priceMatchAudit)
      .where(eq(priceMatchAudit.id, auditId));
    if (!row) throw new ApiException(404, "NOT_FOUND", "No such row");
    return row;
  }

  private async describe(
    executor: DbExecutor,
    records: readonly PriceMatchAuditRecord[],
    lang: CatalogLanguage,
  ): Promise<{ audit: AdminPriceMatchAudit; record: PriceMatchAuditRecord }[]> {
    if (records.length === 0) return [];
    const supplierIds = [...new Set(records.map((record) => record.supplierId))];
    const importIds = [...new Set(records.map((record) => record.importId))];
    const adminIds = [
      ...new Set(
        records.flatMap((record) => (record.decidedByAdminId ? [record.decidedByAdminId] : [])),
      ),
    ];
    const itemIds = [
      ...new Set(
        records.flatMap((record) => [
          record.aiItemId,
          ...(record.correctItemId ? [record.correctItemId] : []),
        ]),
      ),
    ];
    const rowKeys = sql.join(
      records.map((record) => sql`(${record.importId}::uuid, ${record.rowNo}::int)`),
      sql`, `,
    );
    const [companies, imports, rows, items, admins] = await Promise.all([
      executor
        .select({ id: supplier.id, name: supplier.name })
        .from(supplier)
        .where(inArray(supplier.id, supplierIds)),
      executor
        .select({
          id: priceImport.id,
          fileName: priceImport.fileName,
          appliedAt: priceImport.appliedAt,
        })
        .from(priceImport)
        .where(inArray(priceImport.id, importIds)),
      executor
        .select({
          importId: priceImportRow.importId,
          rowNo: priceImportRow.rowNo,
          parsed: priceImportRow.parsed,
          photoText: priceImportRow.photoText,
          aiExplanation: priceImportRow.aiExplanation,
          decidedByMemberId: priceImportRow.decidedByMemberId,
          decidedAt: priceImportRow.decidedAt,
          model: aiJob.model,
        })
        .from(priceImportRow)
        .leftJoin(aiJob, eq(aiJob.id, priceImportRow.aiJobId))
        .where(sql`(${priceImportRow.importId}, ${priceImportRow.rowNo}) IN (${rowKeys})`),
      describeOfferItems(executor, this.photos, itemIds, lang),
      this.adminNames(executor, adminIds),
    ]);
    const memberIds = [
      ...new Set(rows.flatMap((row) => (row.decidedByMemberId ? [row.decidedByMemberId] : []))),
    ];
    const members =
      memberIds.length === 0
        ? []
        : await executor
            .select({ id: supplierMember.id, name: supplierMember.displayName })
            .from(supplierMember)
            .where(inArray(supplierMember.id, memberIds));
    const companyName = new Map(companies.map((row) => [row.id, row.name]));
    const importOf = new Map(imports.map((row) => [row.id, row]));
    const rowOf = new Map(rows.map((row) => [`${row.importId}:${String(row.rowNo)}`, row]));
    const memberName = new Map(members.map((row) => [row.id, row.name]));
    return records.map((record) => {
      const imported = importOf.get(record.importId);
      const row = rowOf.get(`${record.importId}:${String(record.rowNo)}`);
      const confidence = Number(record.aiConfidence);
      return {
        record,
        audit: {
          id: record.id,
          status: record.status,
          version: record.version,
          supplier: { id: record.supplierId, name: companyName.get(record.supplierId) ?? "" },
          import: {
            id: record.importId,
            fileName: imported?.fileName ?? null,
            rowNo: record.rowNo,
            appliedAt: imported?.appliedAt?.toISOString() ?? null,
          },
          row: {
            article: row?.parsed?.article ?? null,
            brand: row?.parsed?.brand ?? null,
            name: row?.parsed?.name ?? null,
            price: row?.parsed?.price ?? null,
            photoText: row?.photoText ?? null,
          },
          aiItem: items.get(record.aiItemId) ?? null,
          aiConfidence: confidence,
          bucket: priceAuditBucket(confidence),
          aiExplanation: row?.aiExplanation ?? null,
          aiModel: row?.model ?? null,
          reason: record.reason,
          acceptedBy: row?.decidedByMemberId
            ? {
                memberId: row.decidedByMemberId,
                name: memberName.get(row.decidedByMemberId) ?? null,
              }
            : null,
          acceptedAt: row?.decidedAt?.toISOString() ?? null,
          correctItem: record.correctItemId ? (items.get(record.correctItemId) ?? null) : null,
          notInCatalog: record.notInCatalog,
          comment: record.comment,
          result: resultView(record.result),
          decidedBy: record.decidedByAdminId
            ? {
                adminId: record.decidedByAdminId,
                name: admins.get(record.decidedByAdminId) ?? null,
              }
            : null,
          decidedAt: record.decidedAt?.toISOString() ?? null,
          createdAt: record.createdAt.toISOString(),
        },
      };
    });
  }

  private async adminNames(
    executor: DbExecutor,
    ids: readonly string[],
  ): Promise<Map<string, string | null>> {
    if (ids.length === 0) return new Map();
    const rows = await executor.execute<{ id: string; name: string | null }>(sql`
      SELECT u.id, a.name FROM ${adminUser} u JOIN account a ON a.id = u.account_id
      WHERE u.id = ANY(${`{${ids.join(",")}}`}::uuid[])`);
    return new Map(rows.rows.map((row) => [row.id, row.name]));
  }
}
