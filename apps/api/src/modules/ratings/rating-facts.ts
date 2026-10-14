import type { OrderKind, OrderStatus, RatingInputs, RatingOrderFacts } from "@adclub/domain";
import { and, gte, inArray, sql, type SQL } from "drizzle-orm";
import type { DbExecutor } from "../../database";
import { customerOrder, inSupplierStatistics, orderEvent } from "../orders";

/**
 * What the rating counts, read from the database (TASK-050; ARCHITECTURE
 * 4.71). The facts of an order (`RatingOrderFacts` of `@adclub/domain`) are
 * the columns below; the count is the SQL twin of `ratingOrderOutcome` and
 * `tallyRatingOrders` — one statement for any number of suppliers. The
 * integration test reads the facts of the same orders, classifies them with
 * the domain and checks the twin gives the same numbers.
 *
 * The window: orders by the moment they were placed, reviews by the moment
 * they were published, within `rating_window_days` of the database's clock.
 * Only orders that count in statistics (`inSupplierStatistics`, the twin of
 * `countsInStatistics`), and only reviews of such orders.
 *
 * The orders module puts this module's job on the queue, so the two import
 * each other: the fragments are built when a statement is, never when the
 * file is loaded.
 */

/** The moves of the journal that are the supplier's answer to a new order. */
const ANSWER_ACTIONS = ["accept", "decline", "propose_term", "propose_time"] as const;

/**
 * The facts of `RatingOrderFacts` and the two verdicts of a term, as SQL over
 * `customer_order` (the only table of the outer statement). Inside a subquery
 * Drizzle would write a column without its table, so the journal and the
 * order are named there in full.
 */
function facts() {
  const event = (condition: SQL) => sql<boolean>`EXISTS (
    SELECT 1 FROM ${orderEvent} AS e WHERE e.order_id = customer_order.id AND ${condition}
  )`;
  const answered = event(
    sql`e.from_status = 'created' AND ${inArray(sql`e.action`, [...ANSWER_ACTIONS])}`,
  );
  const expiredUnanswered = event(sql`e.action = 'expire_no_response'`);
  const takenOn = event(sql`e.to_status = 'accepted'`);
  const closedByAdmin = sql<boolean>`coalesce(${customerOrder.closeMethod} = 'admin', false)`;
  const supplyOverdue = sql<boolean>`(${customerOrder.supplyOverdueNotedAt} IS NOT NULL)`;
  // `term` of `ratingOrderOutcome`: kept / missed (both need the order taken on).
  const kept = sql`(${takenOn} AND NOT ${supplyOverdue}
    AND ${customerOrder.status} = 'completed'
    AND NOT ${customerOrder.closedLate} AND NOT ${closedByAdmin})`;
  const missed = sql`(${takenOn} AND (${supplyOverdue}
    OR ${customerOrder.status} IN ('declined_by_supplier', 'visit_unresolved')))`;
  return { answered, expiredUnanswered, takenOn, closedByAdmin, supplyOverdue, kept, missed };
}

function since(windowDays: number): SQL {
  return sql`now() - make_interval(days => ${windowDays})`;
}

function ordersOf(supplierIds: readonly string[], windowDays: number): SQL | undefined {
  return and(
    inArray(customerOrder.supplierId, [...supplierIds]),
    gte(customerOrder.createdAt, since(windowDays)),
  );
}

/** The facts of every order of these suppliers in the window — test orders too (the domain leaves them out). */
export async function ratingOrderFacts(
  executor: DbExecutor,
  supplierIds: readonly string[],
  windowDays: number,
): Promise<(RatingOrderFacts & { id: string; supplierId: string })[]> {
  if (supplierIds.length === 0) {
    return [];
  }
  const fact = facts();
  const rows = await executor
    .select({
      id: customerOrder.id,
      supplierId: customerOrder.supplierId,
      isTest: customerOrder.isTest,
      kind: customerOrder.kind,
      status: customerOrder.status,
      answered: fact.answered,
      expiredUnanswered: fact.expiredUnanswered,
      takenOn: fact.takenOn,
      closedLate: customerOrder.closedLate,
      closedByAdmin: fact.closedByAdmin,
      supplyOverdue: fact.supplyOverdue,
    })
    .from(customerOrder)
    .where(ordersOf(supplierIds, windowDays));
  return rows.map((row) => ({
    ...row,
    kind: row.kind as OrderKind,
    status: row.status as OrderStatus,
  }));
}

interface CountRow extends Record<string, unknown> {
  supplier_id: string;
  answered: number;
  answer_required: number;
  kept: number;
  judged: number;
}

interface ReviewRow extends Record<string, unknown> {
  supplier_id: string;
  n: number;
  total: number;
}

/**
 * The numbers the rating of each of these suppliers is counted from: the
 * published scores and the orders, in the window. A supplier with nothing
 * gets zeros.
 */
export async function ratingInputs(
  executor: DbExecutor,
  supplierIds: readonly string[],
  windowDays: number,
): Promise<Map<string, RatingInputs>> {
  const inputs = new Map<string, RatingInputs>();
  for (const id of supplierIds) {
    inputs.set(id, {
      reviewsCount: 0,
      reviewsScoreSum: 0,
      answered: 0,
      answerRequired: 0,
      kept: 0,
      judged: 0,
    });
  }
  if (supplierIds.length === 0) {
    return inputs;
  }
  const fact = facts();
  const counted = await executor
    .select({
      supplier_id: customerOrder.supplierId,
      answered: sql<number>`count(*) FILTER (WHERE ${fact.answered})::int`,
      answer_required: sql<number>`count(*) FILTER (WHERE ${fact.answered} OR ${fact.expiredUnanswered})::int`,
      kept: sql<number>`count(*) FILTER (WHERE ${fact.kept})::int`,
      judged: sql<number>`count(*) FILTER (WHERE ${fact.kept} OR ${fact.missed})::int`,
    })
    .from(customerOrder)
    .where(and(ordersOf(supplierIds, windowDays), inSupplierStatistics()))
    .groupBy(customerOrder.supplierId);
  for (const row of counted as CountRow[]) {
    const entry = inputs.get(row.supplier_id)!;
    entry.answered = Number(row.answered);
    entry.answerRequired = Number(row.answer_required);
    entry.kept = Number(row.kept);
    entry.judged = Number(row.judged);
  }
  // `review` belongs to the reviews module, which depends on this one; its
  // table is named here, not imported.
  const reviews = await executor.execute<ReviewRow>(sql`
    SELECT review.supplier_id, count(*)::int AS n, coalesce(sum(review.score), 0)::int AS total
    FROM review
    JOIN ${customerOrder} ON customer_order.id = review.order_id
    WHERE review.status = 'published'
      AND review.published_at >= ${since(windowDays)}
      AND ${inSupplierStatistics()}
      AND ${inArray(sql`review.supplier_id`, [...supplierIds])}
    GROUP BY review.supplier_id
  `);
  for (const row of reviews.rows) {
    const entry = inputs.get(row.supplier_id)!;
    entry.reviewsCount = Number(row.n);
    entry.reviewsScoreSum = Number(row.total);
  }
  return inputs;
}
