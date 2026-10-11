import { activeOrderStatuses, type SupplierOfferType } from "@adclub/domain";
import { and, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import type { DbExecutor } from "../../database";
import { supplier, type SupplierStatus } from "../identity";
import { offer, offerLimits } from "../offers";
import type { AppSettings } from "../settings";
import { supplierLocation } from "../suppliers";
import { planRows, type PlanOffer, type PlanRow, type RowPlan } from "./price-apply-plan";
import { itemsByIds } from "./price-match-items";
import { catalogRequest, priceImportRow, type PriceImportRecord } from "./schema";

/**
 * What the review and the application read about an import (TASK-047):
 * the plan of every row (`planRows` — the same for the preview and for
 * applying) and the offers missing in the file.
 */

export interface PlanContext {
  plans: RowPlan[];
  supplier: { type: SupplierOfferType; status: SupplierStatus; deliveryByDefault: boolean };
  point: { id: string; address: string | null };
}

/**
 * The plan of an import as it would be applied now. `lock` — inside the
 * transaction of applying: the company and its point are share-locked, the
 * items held against archiving, the offers locked for update.
 */
export async function loadPlan(
  executor: DbExecutor,
  record: PriceImportRecord,
  settings: AppSettings,
  lock = false,
): Promise<PlanContext> {
  const companyQuery = executor
    .select({
      type: supplier.type,
      status: supplier.status,
      deliveryByDefault: supplier.deliveryByDefault,
    })
    .from(supplier)
    .where(eq(supplier.id, record.supplierId));
  const [company] = lock ? await companyQuery.for("share") : await companyQuery;
  const pointQuery = executor
    .select({ id: supplierLocation.id, address: supplierLocation.address })
    .from(supplierLocation)
    .where(
      and(eq(supplierLocation.supplierId, record.supplierId), eq(supplierLocation.isDefault, true)),
    );
  const [point] = lock ? await pointQuery.for("share") : await pointQuery;
  if (!company || !point) {
    throw new Error(`The supplier ${record.supplierId} has no company or no pickup point`);
  }
  const stored = await executor
    .select({
      rowNo: priceImportRow.rowNo,
      parsed: priceImportRow.parsed,
      group: priceImportRow.matchGroup,
      source: priceImportRow.matchSource,
      itemId: priceImportRow.itemId,
      decision: priceImportRow.decision,
      decisionItemId: priceImportRow.decisionItemId,
      priceConfirmed: priceImportRow.priceConfirmed,
      sendRequest: priceImportRow.sendRequest,
      keyKind: priceImportRow.matchKeyKind,
      key: priceImportRow.matchKey,
    })
    .from(priceImportRow)
    .where(
      and(
        eq(priceImportRow.importId, record.id),
        eq(priceImportRow.kind, "data"),
        isNotNull(priceImportRow.matchGroup),
        ne(priceImportRow.matchGroup, "error"),
      ),
    );
  const rows: PlanRow[] = stored.flatMap((row) =>
    row.parsed && row.group && row.keyKind && row.key
      ? [
          {
            rowNo: row.rowNo,
            parsed: row.parsed,
            group: row.group,
            source: row.source,
            itemId: row.itemId,
            decision: row.decision,
            decisionItemId: row.decisionItemId,
            priceConfirmed: row.priceConfirmed,
            sendRequest: row.sendRequest,
            keyKind: row.keyKind,
            key: row.key,
          },
        ]
      : [],
  );
  const itemIds = [
    ...new Set(
      rows.flatMap((row) => [
        ...(row.itemId ? [row.itemId] : []),
        ...(row.decisionItemId ? [row.decisionItemId] : []),
      ]),
    ),
  ];
  if (lock && itemIds.length > 0) {
    // Archiving an item waits until the offers on it are written.
    await executor.execute(
      sql`SELECT id FROM catalog_item WHERE id = ANY(${`{${itemIds.join(",")}}`}::uuid[]) FOR SHARE`,
    );
  }
  const items = await itemsByIds(executor, itemIds);
  const offerRows = [];
  for (let start = 0; start < itemIds.length; start += 5000) {
    const query = executor
      .select()
      .from(offer)
      .where(
        and(
          eq(offer.supplierId, record.supplierId),
          eq(offer.locationId, point.id),
          inArray(offer.itemId, itemIds.slice(start, start + 5000)),
        ),
      );
    offerRows.push(...(lock ? await query.for("update") : await query));
  }
  const offers = new Map<string, PlanOffer>(
    offerRows
      .filter((row) => row.itemType !== "service")
      .map((row) => [
        row.itemId,
        {
          id: row.id,
          status: row.status,
          price: row.price,
          availability: row.availability,
          leadDays: row.leadDays,
          pickup: row.pickup,
          delivery: row.delivery,
          warrantyMonths: row.warrantyMonths,
          warrantyText: row.warrantyText,
          supplierSku: row.supplierSku,
          supplierRawName: row.supplierRawName,
          withdrawnReason: row.withdrawnReason,
        },
      ]),
  );
  const requests = await requestKeys(executor, record.supplierId);
  const [limits, sharpPercent] = await Promise.all([
    offerLimits(settings),
    settings.get("price_change_threshold_percent"),
  ]);
  const plans = planRows(rows, {
    supplierType: company.type,
    items,
    offers,
    limits,
    sharpPercent,
    pointHasAddress: point.address !== null && point.address.trim() !== "",
    deliveryByDefault: company.deliveryByDefault,
    openRequests: requests.open,
    rejectedRequests: requests.rejected,
  });
  return { plans, supplier: company, point };
}

/**
 * The keys (`kind:key`) of the company's requests to add an item still
 * open, and of those refused with no open one after them.
 */
export async function requestKeys(
  executor: DbExecutor,
  supplierId: string,
): Promise<{ open: Set<string>; rejected: Set<string> }> {
  const rows = await executor
    .select({
      keyKind: catalogRequest.keyKind,
      key: catalogRequest.key,
      status: catalogRequest.status,
    })
    .from(catalogRequest)
    .where(and(eq(catalogRequest.supplierId, supplierId), ne(catalogRequest.status, "approved")));
  const open = new Set<string>();
  const rejected = new Set<string>();
  for (const row of rows) {
    (row.status === "new" ? open : rejected).add(`${row.keyKind}:${row.key}`);
  }
  for (const key of open) rejected.delete(key);
  return { open, rejected };
}

export interface MissingOfferRow extends Record<string, unknown> {
  id: string;
  item_id: string;
  price: number;
  availability: "in_stock" | "on_order";
  supplier_sku: string | null;
  version: number;
  active_orders: number;
  created_at: string;
}

/**
 * «Пропали из файла» (12.1 step 5): the company's active offers (not
 * services) whose items the file doesn't name. An item is in the file when
 * a row is matched or proposed to it, chosen for it, offers it as a
 * candidate, or names it by its key — the company's remembered match or
 * the item's article — even a row with an error of its own: a file that
 * mentions an item never makes its offer «missing». With the number of
 * orders on each still going through.
 */
export function missingOffersQuery(
  record: PriceImportRecord,
  options: { limit?: number; after?: { createdAt: string; id: string }; count?: boolean } = {},
) {
  const present = sql`
    SELECT item_id AS id FROM price_import_row
      WHERE import_id = ${record.id} AND item_id IS NOT NULL
    UNION SELECT decision_item_id FROM price_import_row
      WHERE import_id = ${record.id} AND decision_item_id IS NOT NULL
    UNION SELECT (c.value->>'itemId')::uuid FROM price_import_row r, jsonb_array_elements(r.candidates) c
      WHERE r.import_id = ${record.id} AND r.candidates IS NOT NULL
    UNION SELECT m.item_id FROM supplier_sku_mapping m
      JOIN price_import_row r ON r.import_id = ${record.id} AND r.match_key_kind = m.key_kind AND r.match_key = m.key
      WHERE m.supplier_id = ${record.supplierId} AND m.item_id IS NOT NULL
    UNION SELECT ci.id FROM catalog_item ci
      JOIN price_import_row r ON r.import_id = ${record.id} AND r.match_key_kind = 'article' AND r.match_key = ci.article_norm`;
  const missing = sql`
    FROM offer o
    WHERE o.supplier_id = ${record.supplierId} AND o.status = 'active' AND o.item_type <> 'service'
      AND NOT EXISTS (SELECT 1 FROM present p WHERE p.id = o.item_id)`;
  if (options.count) {
    return sql`
      WITH present AS (${present})
      SELECT count(*)::int AS offers,
        count(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM customer_order co
          WHERE co.offer_id = o.id AND co.supplier_id = o.supplier_id AND co.status IN (${activeStatuses()})
        ))::int AS with_active_orders
      ${missing}`;
  }
  return sql`
    WITH present AS (${present})
    SELECT o.id, o.item_id, o.price, o.availability, o.supplier_sku, o.version,
      to_char(o.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
      (SELECT count(*)::int FROM customer_order co
        WHERE co.offer_id = o.id AND co.supplier_id = o.supplier_id AND co.status IN (${activeStatuses()})) AS active_orders
    ${missing}
      ${options.after ? sql`AND (o.created_at, o.id) > (${options.after.createdAt}::timestamptz, ${options.after.id}::uuid)` : sql``}
    ORDER BY o.created_at, o.id
    ${options.limit !== undefined ? sql`LIMIT ${options.limit}` : sql``}`;
}

/** The statuses of an order still going through (`activeOrderStatuses`), as SQL values. */
function activeStatuses() {
  return sql.join(
    activeOrderStatuses.map((status) => sql`${status}`),
    sql`, `,
  );
}
