import type { OfferViewerKind } from "@adclub/contracts";
import { and, gte, inArray, lte, sql } from "drizzle-orm";
import type { DbExecutor } from "../../database";
import { customerOrder, inSupplierStatistics } from "../orders";
import { offerViewDaily } from "./schema";

/**
 * The one count of views and orders (TASK-070; ARCHITECTURE 4.88): the
 * signal «Просмотров много, заявок мало», the admin panel's «Просмотры и
 * заявки» and the supplier's statistics (TASK-071) all read it.
 *
 * - views — `offer_view_daily` by kind of viewer;
 * - orders — `customer_order` placed on the day of Almaty, only those that
 *   count in statistics (`inSupplierStatistics`, the twin of
 *   `countsInStatistics`: a test order of an employee does not count).
 *
 * Days of Almaty, both ends included. `byDay` — a row per supplier and day
 * (days with neither views nor orders are not there); otherwise one row per
 * supplier for the whole period.
 */
export interface ViewFacts {
  supplierId: string;
  /** `null` with `byDay: false`. */
  day: string | null;
  views: Record<OfferViewerKind, number>;
  orders: number;
}

export async function viewFacts(
  executor: DbExecutor,
  input: {
    from: string;
    to: string;
    /** Left out — every supplier. */
    supplierIds?: readonly string[];
    byDay: boolean;
  },
): Promise<ViewFacts[]> {
  if (input.supplierIds?.length === 0) {
    return [];
  }
  const orderDay = sql<string>`((${customerOrder.createdAt} AT TIME ZONE 'Asia/Almaty')::date)`;
  const viewDay = sql<string>`${offerViewDaily.day}::text`;
  const [views, orders] = await Promise.all([
    executor
      .select({
        supplierId: offerViewDaily.supplierId,
        day: input.byDay ? viewDay : sql<null>`NULL`,
        kind: offerViewDaily.viewerKind,
        views: sql<number>`sum(${offerViewDaily.views})::int`,
      })
      .from(offerViewDaily)
      .where(
        and(
          gte(offerViewDaily.day, input.from),
          lte(offerViewDaily.day, input.to),
          input.supplierIds
            ? inArray(offerViewDaily.supplierId, [...input.supplierIds])
            : undefined,
        ),
      )
      .groupBy(
        ...(input.byDay
          ? [offerViewDaily.supplierId, offerViewDaily.day, offerViewDaily.viewerKind]
          : [offerViewDaily.supplierId, offerViewDaily.viewerKind]),
      ),
    executor
      .select({
        supplierId: customerOrder.supplierId,
        day: input.byDay ? sql<string>`${orderDay}::text` : sql<null>`NULL`,
        orders: sql<number>`count(*)::int`,
      })
      .from(customerOrder)
      .where(
        and(
          inSupplierStatistics(),
          sql`${orderDay} BETWEEN ${input.from}::date AND ${input.to}::date`,
          input.supplierIds ? inArray(customerOrder.supplierId, [...input.supplierIds]) : undefined,
        ),
      )
      .groupBy(
        ...(input.byDay ? [customerOrder.supplierId, orderDay] : [customerOrder.supplierId]),
      ),
  ]);
  const found = new Map<string, ViewFacts>();
  const entry = (supplierId: string, day: string | null): ViewFacts => {
    const id = `${supplierId}|${day ?? ""}`;
    let row = found.get(id);
    if (!row) {
      row = { supplierId, day, views: { guest: 0, user: 0, club: 0 }, orders: 0 };
      found.set(id, row);
    }
    return row;
  };
  for (const row of views) {
    entry(row.supplierId, row.day).views[row.kind] += Number(row.views);
  }
  for (const row of orders) {
    entry(row.supplierId, row.day).orders += Number(row.orders);
  }
  return [...found.values()];
}
