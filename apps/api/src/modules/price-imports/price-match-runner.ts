import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  exactArticleDecision,
  priceRowKey,
  rankCandidates,
  repeatedRows,
  searchWords,
  strongCandidate,
  type ParsedPriceRow,
  type PriceRowKey,
  type SupplierOfferType,
} from "@adclub/domain";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { PriceMatchSource } from "@adclub/contracts";
import { DatabaseService, type DbExecutor } from "../../database";
import {
  JobQueue,
  type JobHandler,
  type JobRunContext,
  type JobRunOutcome,
  type PeriodicJobHandler,
} from "../../jobs";
import { AiBudgetExhaustedError, AiGatewayError, AiService, FALLBACK_WORTHY } from "../ai";
import { supplier } from "../identity";
import { AppSettings } from "../settings";
import { matchPricesAiJob, matchPricesJob } from "./price-import-jobs";
import {
  brandsBySpelling,
  itemRefusal,
  itemsByArticles,
  itemsByIds,
  nameCandidate,
  nameRow,
  rowBrandIds,
  type MatchItem,
} from "./price-match-items";
import { PriceNameIndex } from "./price-name-index";
import {
  priceImport,
  priceImportRow,
  supplierSkuMapping,
  type PriceImportRecord,
  type PriceImportStatsRecord,
  type PriceMatchError,
  type PriceMatchNote,
  type PriceRowGroup,
  type StoredCandidate,
} from "./schema";

/** Rows of goods decided by the deterministic steps in one write. */
const BATCH = 500;
/** A run that hasn't shown signs of life this long has stopped: another may take the import. */
const CLAIM_STALE_SECONDS = 120;
/** An import in matching untouched this long, with no run alive, is put back on the queue. */
const WAKE_IDLE_SECONDS = 60;
/** Candidates handed to AI and shown to the supplier. */
const CANDIDATES = 3;
/** Items the search by name considers for one row. */
const SEARCH_POOL = 30;
/** Words of a row the search by name tries. */
const SEARCH_WORDS = 3;
/** The longest explanation of AI kept. */
const EXPLANATION_MAX = 300;

/** The import left matching (columns confirmed again, expired) — this run stops. */
class MatchingSuperseded extends Error {
  constructor() {
    super("The import is no longer being matched by this run");
  }
}

/** What a step decided about one row. */
interface RowResult {
  rowNo: number;
  stage: "ai" | "done";
  group: PriceRowGroup | null;
  source: PriceMatchSource | null;
  itemId: string | null;
  candidates: StoredCandidate[] | null;
  note: PriceMatchNote | null;
  error: PriceMatchError | null;
  aiProposed?: boolean;
  aiConfidence?: number | null;
  aiExplanation?: string | null;
}

function done(
  rowNo: number,
  group: PriceRowGroup,
  source: PriceMatchSource | null,
  extra: Partial<RowResult> = {},
): RowResult {
  return {
    rowNo,
    stage: "done",
    group,
    source,
    itemId: null,
    candidates: null,
    note: null,
    error: null,
    ...extra,
  };
}

/**
 * Matching the rows of a price list with the catalog (`prices.match`,
 * `prices.match-ai`; TASK-047 requirement 1; ARCHITECTURE 12.1 step 4,
 * 4.67). The first step that decides a row wins:
 *
 * 1. the company's remembered match of the row's key (`supplier_sku_mapping`)
 *    → «уверенно»;
 * 2. the exact article and the brand by any of its spellings
 *    (`exactArticleDecision`) → «уверенно» or «нужно проверить»;
 *    a remembered «пропустить» / «нет в справочнике» → «не найдено»;
 * 3. the search by the name, the one sure candidate (`strongCandidate`) →
 *    «уверенно»; candidates without a sure one → AI;
 * 4. AI in batches: its choice → «нужно проверить» («предложено ИИ»), at or
 *    above `price_match_confidence_threshold` with the choice proposed;
 *    «нет» → «не найдено».
 *
 * Only active goods of visible subcategories the company may sell are
 * candidates; services are never imported. Rows repeating an earlier one
 * and every row of a company of services are errors. A run claims the
 * import (`phase_started_at` as a heartbeat), so two never match one import
 * at once, and resumes where a stopped one left. AI out of reach or out of
 * budget — the import waits in `matching` and the job comes back by itself.
 */
@Injectable()
export class PriceMatcher {
  private readonly logger = new Logger("PriceImports");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(JobQueue) private readonly queue: JobQueue,
    @Inject(AiService) private readonly ai: AiService,
  ) {}

  /** The deterministic steps; the rest goes to AI or the matching ends. */
  async match(importId: string, context: JobRunContext): Promise<void> {
    const db = this.database.db;
    await db
      .update(priceImport)
      .set({ status: "matching", phaseStartedAt: null, updatedAt: new Date() })
      .where(and(eq(priceImport.id, importId), eq(priceImport.status, "parsed")));
    const record = await this.claim(importId);
    if (!record) return;
    const startedAt = Date.now();
    try {
      const supplierType = await this.supplierType(record.supplierId);
      await this.prepare(record, supplierType);
      const timing = { prepare: Date.now() - startedAt, decide: 0, write: 0, progress: 0 };
      // The names of the catalog, loaded once per run and only when a row needs the search.
      let index: Promise<PriceNameIndex> | undefined;
      const names = () => (index ??= PriceNameIndex.load(db));
      for (;;) {
        if (context.signal.aborted) throw new Error("Stopped while matching a price list");
        const batch = await db
          .select({ rowNo: priceImportRow.rowNo, parsed: priceImportRow.parsed })
          .from(priceImportRow)
          .where(
            and(
              eq(priceImportRow.importId, importId),
              eq(priceImportRow.kind, "data"),
              isNull(priceImportRow.matchStage),
            ),
          )
          .orderBy(asc(priceImportRow.rowNo))
          .limit(BATCH);
        if (batch.length === 0) break;
        let mark = Date.now();
        const results = await this.decide(record.supplierId, supplierType, batch, names);
        timing.decide += Date.now() - mark;
        mark = Date.now();
        await this.write(record, results);
        timing.write += Date.now() - mark;
        mark = Date.now();
        await this.progress(record);
        timing.progress += Date.now() - mark;
      }
      this.logger.log(
        `Price rows matched without AI import=${importId} durationMs=${String(Date.now() - startedAt)} phasesMs=prepare:${String(timing.prepare)},decide:${String(timing.decide)},write:${String(timing.write)},progress:${String(timing.progress)}`,
      );
      if (await this.aiPending(importId)) {
        await this.release(importId);
        await this.queue.enqueue(matchPricesAiJob, { importId }, { singletonKey: importId });
        return;
      }
      await this.finish(record);
    } catch (error) {
      if (error instanceof MatchingSuperseded) return;
      await this.release(importId).catch(() => undefined);
      throw error;
    }
  }

  /** The rows left to AI, in batches; waits (and comes back) when AI can't answer. */
  async matchAi(importId: string, context: JobRunContext): Promise<void> {
    const record = await this.claim(importId);
    if (!record) return;
    try {
      for (;;) {
        if (context.signal.aborted) throw new Error("Stopped while matching a price list");
        const [batchSize, threshold] = await Promise.all([
          this.settings.get("price_match_batch_size"),
          this.settings.get("price_match_confidence_threshold"),
        ]);
        const rows = await this.database.db
          .select({
            rowNo: priceImportRow.rowNo,
            parsed: priceImportRow.parsed,
            candidates: priceImportRow.candidates,
          })
          .from(priceImportRow)
          .where(
            and(
              eq(priceImportRow.importId, importId),
              eq(priceImportRow.kind, "data"),
              eq(priceImportRow.matchStage, "ai"),
            ),
          )
          .orderBy(asc(priceImportRow.rowNo))
          .limit(batchSize);
        if (rows.length === 0) {
          await this.finish(record);
          return;
        }
        const items = await itemsByIds(
          this.database.db,
          rows.flatMap((row) => (row.candidates ?? []).map((candidate) => candidate.itemId)),
        );
        const results = await this.askAi(record, rows, items, threshold);
        if (results === "wait") return;
        await this.write(record, results);
        await this.progress(record, { aiRows: results.length });
      }
    } catch (error) {
      if (error instanceof MatchingSuperseded) return;
      await this.release(importId).catch(() => undefined);
      throw error;
    }
  }

  // ------------------------------------------------------------ the steps

  /**
   * Before the steps: every row gets its key; a row with an error of the
   * reading, a row repeating an earlier one (`repeatedRows`: the first one
   * decides) and every row of a company of services are errors.
   */
  private async prepare(record: PriceImportRecord, supplierType: SupplierOfferType): Promise<void> {
    const rows = await this.database.db
      .select({
        rowNo: priceImportRow.rowNo,
        parsed: priceImportRow.parsed,
        errors: priceImportRow.errors,
        stage: priceImportRow.matchStage,
      })
      .from(priceImportRow)
      .where(and(eq(priceImportRow.importId, record.id), eq(priceImportRow.kind, "data")));
    // A row with an error keeps its key too: the item it names is in the
    // file, and an offer on it is not «missing» (`missingOffers`).
    const keyed = rows.map((row) => ({
      ...row,
      key: row.parsed ? priceRowKey(row.parsed) : null,
    }));
    const repeated = repeatedRows(keyed.filter((row) => !row.errors));
    const updates: {
      row_no: number;
      kind: string | null;
      key: string | null;
      stage: string | null;
      grp: string | null;
      err: PriceMatchError | null;
    }[] = [];
    for (const row of keyed) {
      if (row.stage !== null) continue;
      const key: PriceRowKey | null = row.key;
      const base = { row_no: row.rowNo, kind: key?.kind ?? null, key: key?.key ?? null };
      const first = row.errors ? undefined : repeated.get(row.rowNo);
      if (row.errors || !key) {
        updates.push({ ...base, stage: "done", grp: "error", err: null });
      } else if (first !== undefined) {
        updates.push({
          ...base,
          stage: "done",
          grp: "error",
          err: { code: "repeated_row", value: first },
        });
      } else if (supplierType === "services") {
        // Services are not imported, and a company of services sells nothing else.
        updates.push({ ...base, stage: "done", grp: "error", err: { code: "supplier_type" } });
      } else {
        updates.push({ ...base, stage: null, grp: null, err: null });
      }
    }
    for (let start = 0; start < updates.length; start += 1000) {
      const chunk = updates.slice(start, start + 1000);
      await this.guarded(record, (tx) =>
        tx.execute(sql`
          UPDATE price_import_row r
          SET match_key_kind = x.kind, match_key = x.key, match_stage = x.stage,
              match_group = x.grp, match_error = x.err
          FROM jsonb_to_recordset(${JSON.stringify(chunk)}::jsonb)
            AS x(row_no int, kind text, key text, stage text, grp text, err jsonb)
          WHERE r.import_id = ${record.id} AND r.row_no = x.row_no`),
      );
    }
  }

  /** Steps 1–3 for a batch of rows (every row of it gets a result). */
  private async decide(
    supplierId: string,
    supplierType: SupplierOfferType,
    batch: { rowNo: number; parsed: ParsedPriceRow | null }[],
    names: () => Promise<PriceNameIndex>,
  ): Promise<RowResult[]> {
    const db = this.database.db;
    const rows = batch.map((row) => ({
      rowNo: row.rowNo,
      parsed: row.parsed!,
      key: priceRowKey(row.parsed!)!,
    }));
    const mappings = await this.mappingsOf(
      supplierId,
      rows.map((row) => row.key),
    );
    const mapped = await itemsByIds(
      db,
      [...mappings.values()].flatMap((mapping) => (mapping.itemId ? [mapping.itemId] : [])),
    );
    // Rows the company's memory already decides need no look at the articles.
    const remembered = (row: (typeof rows)[number]) => {
      const mapping = mappings.get(`${row.key.kind}:${row.key.key}`);
      return (
        mapping?.decision === "item" &&
        itemRefusal(mapped.get(mapping.itemId!), supplierType) === null
      );
    };
    const byArticle = await itemsByArticles(
      db,
      rows.flatMap((row) =>
        row.parsed.articleNorm && !remembered(row) ? [row.parsed.articleNorm] : [],
      ),
    );
    const brands = await brandsBySpelling(
      db,
      rows.flatMap((row) => (row.parsed.brand ? [row.parsed.brand] : [])),
    );
    const results: RowResult[] = [];
    for (const row of rows) {
      const mapping = mappings.get(`${row.key.kind}:${row.key.key}`);
      // 1. The company's remembered match.
      if (mapping?.decision === "item") {
        const item = mapped.get(mapping.itemId!);
        const refusal = itemRefusal(item, supplierType);
        if (refusal === null) {
          results.push(done(row.rowNo, "confident", "mapping", { itemId: item!.id }));
          continue;
        }
        if (refusal === "service_item") {
          results.push(done(row.rowNo, "error", "mapping", { error: { code: "service_item" } }));
          continue;
        }
        // The item left the catalog since: the next steps look again.
      }
      // 2. The exact article and the brand.
      if (row.parsed.articleNorm) {
        const all = byArticle.get(row.parsed.articleNorm) ?? [];
        const goods = all.filter((item) => itemRefusal(item, supplierType) === null);
        if (goods.length === 0 && all.some((item) => item.itemType === "service")) {
          results.push(
            done(row.rowNo, "error", "exact_article", { error: { code: "service_item" } }),
          );
          continue;
        }
        const decision = exactArticleDecision(
          goods.map((item) => ({ itemId: item.id, brandId: item.brandId })),
          rowBrandIds(row.parsed.brand, brands),
        );
        if (decision.kind === "confident") {
          results.push(done(row.rowNo, "confident", "exact_article", { itemId: decision.itemId }));
          continue;
        }
        if (decision.kind === "review") {
          results.push(
            done(row.rowNo, "review", "exact_article", {
              candidates: decision.itemIds
                .slice(0, CANDIDATES)
                .map((itemId) => ({ itemId, score: 1 })),
              note: { code: decision.reason, rowNo: null },
            }),
          );
          continue;
        }
      }
      // The supplier's earlier «пропустить» / «нет в справочнике»: no search, no AI.
      if (mapping?.decision === "skip") {
        results.push(done(row.rowNo, "not_found", "remembered_skip"));
        continue;
      }
      if (mapping?.decision === "absent") {
        results.push(done(row.rowNo, "not_found", "remembered_absent"));
        continue;
      }
      // 3. The search by the name.
      const words = searchWords(nameRow(row.parsed), SEARCH_WORDS);
      const pool = words.length > 0 ? (await names()).candidates(words, SEARCH_POOL) : [];
      const named = pool.map(nameCandidate);
      const strong = strongCandidate(nameRow(row.parsed), named);
      if (strong) {
        results.push(done(row.rowNo, "confident", "search", { itemId: strong.itemId }));
        continue;
      }
      const ranked = rankCandidates(nameRow(row.parsed), named, CANDIDATES);
      if (ranked.length > 0) {
        results.push({
          ...done(row.rowNo, "review", "search", {
            candidates: ranked.map((entry) => ({
              itemId: entry.candidate.itemId,
              score: Math.round(entry.score * 1000) / 1000,
            })),
          }),
          stage: "ai",
          group: null,
        });
        continue;
      }
      results.push(done(row.rowNo, "not_found", null));
    }
    return results;
  }

  /**
   * Step 4: one batch to AI. Its choice must be one of the row's candidates;
   * a row it left out is asked again with the next batch. A failure that
   * passes (out of reach, out of budget) — the import waits; a failure no
   * retry fixes — the rows go to the supplier with their candidates.
   */
  private async askAi(
    record: PriceImportRecord,
    rows: { rowNo: number; parsed: ParsedPriceRow | null; candidates: StoredCandidate[] | null }[],
    items: Map<string, MatchItem>,
    threshold: number,
  ): Promise<RowResult[] | "wait"> {
    const input = {
      rows: rows.map((row) => ({
        id: String(row.rowNo),
        article: row.parsed?.article ?? null,
        brand: row.parsed?.brand ?? null,
        name: row.parsed?.name ?? null,
        candidates: (row.candidates ?? []).flatMap((candidate) => {
          const item = items.get(candidate.itemId);
          return item
            ? [
                {
                  id: item.id,
                  name: item.name,
                  brand: item.brandSpellings[0] ?? null,
                  article: item.article,
                  category: item.categoryName,
                },
              ]
            : [];
        }),
      })),
    };
    let answer;
    try {
      answer = await this.ai.matchPrices(input, {
        initiator: { type: "system" },
        inputRef: { importId: record.id, rows: rows.length },
      });
    } catch (error) {
      if (error instanceof AiBudgetExhaustedError) {
        await this.wait(record, "budget");
        return "wait";
      }
      if (error instanceof AiGatewayError && FALLBACK_WORTHY.includes(error.kind)) {
        await this.wait(record, "unavailable");
        return "wait";
      }
      if (error instanceof AiGatewayError) {
        this.logger.warn(
          `AI could not match price rows import=${record.id} rows=${String(rows.length)} error=${error.kind}: the supplier chooses among the candidates`,
        );
        return rows.map((row) => this.withoutAi(row));
      }
      throw error;
    }
    const byRow = new Map(answer.output.matches.map((match) => [match.id, match]));
    const results: RowResult[] = [];
    for (const row of rows) {
      const match = byRow.get(String(row.rowNo));
      if (!match) continue;
      const candidates = row.candidates ?? [];
      const confidence = Math.min(
        1,
        Math.max(0, Number.isFinite(match.confidence) ? match.confidence : 0),
      );
      const explanation = match.explanation.trim().slice(0, EXPLANATION_MAX) || null;
      const ai = { aiConfidence: Math.round(confidence * 1000) / 1000, aiExplanation: explanation };
      if (match.itemId === null) {
        results.push(done(row.rowNo, "not_found", "ai", { candidates, ...ai }));
        continue;
      }
      const chosen = candidates.find((candidate) => candidate.itemId === match.itemId);
      if (!chosen) {
        // Not one of the candidates: the answer doesn't count.
        results.push(this.withoutAi(row));
        continue;
      }
      results.push(
        done(row.rowNo, "review", "ai", {
          itemId: confidence >= threshold ? chosen.itemId : null,
          candidates: [chosen, ...candidates.filter((candidate) => candidate !== chosen)],
          aiProposed: true,
          ...ai,
        }),
      );
    }
    // A provider that answered none of the rows: they go to the supplier, not round again.
    return results.length > 0 ? results : rows.map((row) => this.withoutAi(row));
  }

  private withoutAi(row: { rowNo: number; candidates: StoredCandidate[] | null }): RowResult {
    return done(row.rowNo, "review", "search", { candidates: row.candidates ?? [] });
  }

  /** AI can't answer now: the import says why, and the job comes back later by itself. */
  private async wait(record: PriceImportRecord, reason: "unavailable" | "budget"): Promise<void> {
    const db = this.database.db;
    const retrySeconds = await this.settings.get("price_match_retry_seconds");
    const [current] = await db
      .select({ stats: priceImport.stats })
      .from(priceImport)
      .where(eq(priceImport.id, record.id));
    await db
      .update(priceImport)
      .set({
        stats: { ...(current?.stats ?? {}), aiWaiting: reason },
        phaseStartedAt: null,
        updatedAt: new Date(),
      })
      .where(and(eq(priceImport.id, record.id), eq(priceImport.status, "matching")));
    await this.queue.enqueue(
      matchPricesAiJob,
      { importId: record.id },
      { singletonKey: record.id, startAfter: new Date(Date.now() + retrySeconds * 1000) },
    );
    this.logger.warn(
      `Price matching waits for AI import=${record.id} reason=${reason} retryInSeconds=${String(retrySeconds)}`,
    );
  }

  // ------------------------------------------------------------- the end

  /**
   * The end of matching: two different rows sure of one item both go to
   * the supplier («нужно проверить», each naming the other), the groups are
   * counted, the review begins and is kept `price_import_review_days`.
   */
  private async finish(record: PriceImportRecord): Promise<void> {
    const startedAt = Date.now();
    const days = await this.settings.get("price_import_review_days");
    const db = this.database.db;
    const confident = await db
      .select({ rowNo: priceImportRow.rowNo, itemId: priceImportRow.itemId })
      .from(priceImportRow)
      .where(
        and(eq(priceImportRow.importId, record.id), eq(priceImportRow.matchGroup, "confident")),
      )
      .orderBy(asc(priceImportRow.rowNo));
    const byItem = new Map<string, number[]>();
    for (const row of confident) {
      if (!row.itemId) continue;
      byItem.set(row.itemId, [...(byItem.get(row.itemId) ?? []), row.rowNo]);
    }
    const shared = [...byItem.values()]
      .filter((rowNos) => rowNos.length > 1)
      .flatMap((rowNos) =>
        rowNos.map((rowNo) => ({
          row_no: rowNo,
          note: { code: "same_item", rowNo: rowNos.find((other) => other !== rowNo)! },
        })),
      );
    await this.guarded(record, async (tx) => {
      if (shared.length > 0) {
        await tx.execute(sql`
          UPDATE price_import_row r
          SET match_group = 'review', match_note = x.note
          FROM jsonb_to_recordset(${JSON.stringify(shared)}::jsonb) AS x(row_no int, note jsonb)
          WHERE r.import_id = ${record.id} AND r.row_no = x.row_no`);
      }
      const stats = await this.counts(tx, record.id);
      const [current] = await tx
        .select({ stats: priceImport.stats })
        .from(priceImport)
        .where(eq(priceImport.id, record.id));
      await tx
        .update(priceImport)
        .set({
          status: "review",
          stats: { ...(current?.stats ?? {}), ...stats, aiWaiting: null },
          matchedAt: new Date(),
          reviewUntil: new Date(Date.now() + days * 24 * 60 * 60 * 1000),
          phaseStartedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(priceImport.id, record.id));
    });
    this.logger.log(
      `Price list matched import=${record.id} sameItemRows=${String(shared.length)} finishMs=${String(Date.now() - startedAt)}`,
    );
  }

  /** The groups and the sources, as `stats` keeps them. */
  private async counts(executor: DbExecutor, importId: string): Promise<PriceImportStatsRecord> {
    const rows = await executor.execute<{
      matched: number;
      confident: number;
      review: number;
      not_found: number;
      errors: number;
      mapping: number;
      exact_article: number;
      search: number;
      ai: number;
      remembered: number;
      ai_pending: number;
    }>(sql`
      SELECT
        count(*) FILTER (WHERE match_stage = 'done')::int AS matched,
        count(*) FILTER (WHERE match_group = 'confident')::int AS confident,
        count(*) FILTER (WHERE match_group = 'review')::int AS review,
        count(*) FILTER (WHERE match_group = 'not_found')::int AS not_found,
        count(*) FILTER (WHERE match_group = 'error')::int AS errors,
        count(*) FILTER (WHERE match_source = 'mapping' AND match_group <> 'error')::int AS mapping,
        count(*) FILTER (WHERE match_source = 'exact_article' AND match_group <> 'error')::int AS exact_article,
        count(*) FILTER (WHERE match_source = 'search' AND match_stage = 'done')::int AS search,
        count(*) FILTER (WHERE match_source = 'ai')::int AS ai,
        count(*) FILTER (WHERE match_source IN ('remembered_skip', 'remembered_absent'))::int AS remembered,
        count(*) FILTER (WHERE match_stage = 'ai')::int AS ai_pending
      FROM price_import_row
      WHERE import_id = ${importId} AND kind = 'data'`);
    const row = rows.rows[0]!;
    return {
      matched: row.matched,
      confident: row.confident,
      review: row.review,
      notFound: row.not_found,
      errors: row.errors,
      bySource: {
        mapping: row.mapping,
        exactArticle: row.exact_article,
        search: row.search,
        ai: row.ai,
        remembered: row.remembered,
      },
      aiPending: row.ai_pending,
    };
  }

  /** The progress in `stats` and a sign of life of this run. */
  private async progress(record: PriceImportRecord, add: { aiRows?: number } = {}): Promise<void> {
    await this.guarded(record, async (tx) => {
      const counts = await this.counts(tx, record.id);
      const [current] = await tx
        .select({ stats: priceImport.stats })
        .from(priceImport)
        .where(eq(priceImport.id, record.id));
      const stats = current?.stats ?? {};
      await tx
        .update(priceImport)
        .set({
          stats: {
            ...stats,
            ...counts,
            aiRows: (stats.aiRows ?? 0) + (add.aiRows ?? 0),
            aiWaiting: null,
          },
          phaseStartedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(priceImport.id, record.id));
    });
  }

  private async write(record: PriceImportRecord, results: readonly RowResult[]): Promise<void> {
    const payload = results.map((result) => ({
      row_no: result.rowNo,
      stage: result.stage,
      grp: result.group,
      src: result.source,
      item_id: result.itemId,
      candidates: result.candidates,
      note: result.note,
      err: result.error,
      ai_proposed: result.aiProposed ?? false,
      ai_confidence: result.aiConfidence ?? null,
      ai_explanation: result.aiExplanation ?? null,
    }));
    for (let start = 0; start < payload.length; start += 1000) {
      const chunk = payload.slice(start, start + 1000);
      await this.guarded(record, (tx) =>
        tx.execute(sql`
          UPDATE price_import_row r
          SET match_stage = x.stage, match_group = x.grp, match_source = x.src,
              item_id = x.item_id, candidates = x.candidates, match_note = x.note,
              match_error = x.err, ai_proposed = x.ai_proposed,
              ai_confidence = x.ai_confidence, ai_explanation = x.ai_explanation
          FROM jsonb_to_recordset(${JSON.stringify(chunk)}::jsonb)
            AS x(row_no int, stage text, grp text, src text, item_id uuid, candidates jsonb,
                 note jsonb, err jsonb, ai_proposed boolean, ai_confidence numeric,
                 ai_explanation text)
          WHERE r.import_id = ${record.id} AND r.row_no = x.row_no`),
      );
    }
  }

  /**
   * A write of this run, only while the import is still matched by the
   * confirmation it began with: the import is share-locked, so a new
   * confirmation of the columns (which locks it for update) either comes
   * after and resets the rows, or the write sees it and the run stops.
   */
  private async guarded(
    record: PriceImportRecord,
    write: (tx: DbExecutor) => Promise<unknown>,
  ): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      const [current] = await tx
        .select({ status: priceImport.status, version: priceImport.version })
        .from(priceImport)
        .where(eq(priceImport.id, record.id))
        .for("share");
      if (current?.status !== "matching" || current.version !== record.version) {
        throw new MatchingSuperseded();
      }
      await write(tx);
    });
  }

  // -------------------------------------------------------------- helpers

  /**
   * Takes the import for this run: nobody else works on it (no heartbeat in
   * `CLAIM_STALE_SECONDS`). `null` — another run is alive, or the import is
   * no longer matched.
   */
  private async claim(importId: string): Promise<PriceImportRecord | null> {
    const [claimed] = await this.database.db
      .update(priceImport)
      .set({ phaseStartedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(priceImport.id, importId),
          eq(priceImport.status, "matching"),
          sql`(${priceImport.phaseStartedAt} IS NULL OR ${priceImport.phaseStartedAt} < now() - make_interval(secs => ${CLAIM_STALE_SECONDS}))`,
        ),
      )
      .returning();
    return claimed ?? null;
  }

  private async release(importId: string): Promise<void> {
    await this.database.db
      .update(priceImport)
      .set({ phaseStartedAt: null })
      .where(and(eq(priceImport.id, importId), eq(priceImport.status, "matching")));
  }

  private async aiPending(importId: string): Promise<boolean> {
    const [row] = await this.database.db
      .select({ rowNo: priceImportRow.rowNo })
      .from(priceImportRow)
      .where(and(eq(priceImportRow.importId, importId), eq(priceImportRow.matchStage, "ai")))
      .limit(1);
    return row !== undefined;
  }

  private async supplierType(supplierId: string): Promise<SupplierOfferType> {
    const [row] = await this.database.db
      .select({ type: supplier.type })
      .from(supplier)
      .where(eq(supplier.id, supplierId));
    return row?.type ?? "goods";
  }

  /** The company's remembered matches of these keys, by `kind:key`. */
  private async mappingsOf(
    supplierId: string,
    keys: readonly PriceRowKey[],
  ): Promise<Map<string, { decision: "item" | "skip" | "absent"; itemId: string | null }>> {
    const found = new Map<
      string,
      { decision: "item" | "skip" | "absent"; itemId: string | null }
    >();
    if (keys.length === 0) return found;
    const rows = await this.database.db
      .select({
        keyKind: supplierSkuMapping.keyKind,
        key: supplierSkuMapping.key,
        decision: supplierSkuMapping.decision,
        itemId: supplierSkuMapping.itemId,
      })
      .from(supplierSkuMapping)
      .where(
        and(
          eq(supplierSkuMapping.supplierId, supplierId),
          inArray(
            supplierSkuMapping.key,
            keys.map((key) => key.key),
          ),
        ),
      );
    for (const row of rows) {
      found.set(`${row.keyKind}:${row.key}`, { decision: row.decision, itemId: row.itemId });
    }
    return found;
  }
}

/** `prices.match` → `PriceMatcher.match`. */
@Injectable()
export class PriceMatchJob implements JobHandler<{ importId: string }> {
  constructor(@Inject(PriceMatcher) private readonly matcher: PriceMatcher) {}

  run({ importId }: { importId: string }, context: JobRunContext): Promise<void> {
    return this.matcher.match(importId, context);
  }
}

/** `prices.match-ai` → `PriceMatcher.matchAi`. */
@Injectable()
export class PriceMatchAiJob implements JobHandler<{ importId: string }> {
  constructor(@Inject(PriceMatcher) private readonly matcher: PriceMatcher) {}

  run({ importId }: { importId: string }, context: JobRunContext): Promise<void> {
    return this.matcher.matchAi(importId, context);
  }
}

/**
 * Every minute (`prices.match-wake`): an import read or matched that no run
 * has shown a sign of life for — a worker stopped with it, AI came back — is
 * put back on the queue: the deterministic steps if rows are left to them,
 * AI otherwise. A run already waiting for the import keeps it (one per key).
 */
@Injectable()
export class PriceMatchWake implements PeriodicJobHandler {
  private readonly logger = new Logger("PriceImports");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(JobQueue) private readonly queue: JobQueue,
  ) {}

  async run(): Promise<JobRunOutcome> {
    // The imports first, their rows in statements of their own: one statement
    // never holds the import while it waits for the rows.
    const idle = await this.database.db.execute<{ id: string; status: string }>(sql`
      SELECT i.id, i.status
      FROM price_import i
      WHERE i.status IN ('parsed', 'matching')
        AND (i.phase_started_at IS NULL
          OR i.phase_started_at < now() - make_interval(secs => ${CLAIM_STALE_SECONDS}))
        AND i.updated_at < now() - make_interval(secs => ${WAKE_IDLE_SECONDS})
      ORDER BY i.updated_at
      LIMIT 100`);
    let queued = 0;
    for (const row of idle.rows) {
      const [left] =
        row.status === "parsed"
          ? [{ rowNo: 0 }]
          : await this.database.db
              .select({ rowNo: priceImportRow.rowNo })
              .from(priceImportRow)
              .where(
                and(
                  eq(priceImportRow.importId, row.id),
                  eq(priceImportRow.kind, "data"),
                  isNull(priceImportRow.matchStage),
                ),
              )
              .limit(1);
      const id = await this.queue.enqueue(
        left ? matchPricesJob : matchPricesAiJob,
        { importId: row.id },
        { singletonKey: row.id },
      );
      if (id) queued++;
    }
    if (queued > 0)
      this.logger.log(`Price matching put back on the queue imports=${String(queued)}`);
    return { worked: queued > 0 };
  }
}

/**
 * Every minute (`prices.expire-reviews`): a review left past its
 * `review_until`, or a matching longer than `price_import_review_days`
 * since the rows were read, expires — nothing of it is applied; the rows
 * stay as the history.
 */
@Injectable()
export class PriceReviewExpiry implements PeriodicJobHandler {
  private readonly logger = new Logger("PriceImports");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AppSettings) private readonly settings: AppSettings,
  ) {}

  async run(): Promise<JobRunOutcome> {
    const days = await this.settings.get("price_import_review_days");
    const expired = await this.database.db
      .update(priceImport)
      .set({ status: "expired", phaseStartedAt: null, updatedAt: new Date() })
      .where(
        sql`(${priceImport.status} = 'review' AND ${priceImport.reviewUntil} < now())
          OR (${priceImport.status} IN ('parsed', 'matching')
            AND ${priceImport.parsedAt} < now() - make_interval(days => ${days}))`,
      )
      .returning({ id: priceImport.id });
    if (expired.length > 0) {
      this.logger.log(`Price list reviews expired imports=${String(expired.length)}`);
    }
    return { worked: expired.length > 0 };
  }
}
