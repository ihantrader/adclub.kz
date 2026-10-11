import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  auditActions,
  auditEntities,
  type PriceImportResult,
  type PriceRowNotAppliedReason,
} from "@adclub/contracts";
import { eq, sql } from "drizzle-orm";
import { DatabaseService, type DbExecutor } from "../../database";
import type { JobHandler } from "../../jobs";
import { AuditLog, type AuditActorRecord, type AuditEntryInput } from "../audit";
import { supplierMember } from "../identity";
import { AppSettings } from "../settings";
import type { RowPlan } from "./price-apply-plan";
import { loadPlan, missingOffersQuery, type MissingOfferRow } from "./price-review-data";
import { priceImport, type CatalogRequestPayload, type PriceImportRecord } from "./schema";

type SupplierActor = Extract<AuditActorRecord, { role: "supplier" }>;

/** Rows of one statement of the bulk writes. */
const CHUNK = 1000;

function chunks<T>(list: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < list.length; start += CHUNK) {
    result.push(list.slice(start, start + CHUNK));
  }
  return result;
}

/**
 * Applying a reviewed price list (`prices.apply`; TASK-047 requirement 4;
 * ARCHITECTURE 12.1 step 7, 4.67): **one transaction** under the lock of the
 * import, by the plan of every row (`planRows` — the very numbers the review
 * showed, now with the offers locked): new offers created, offers updated,
 * withdrawn by «нет в наличии», returned to sale, the missing ones withdrawn
 * when the supplier chose so, requests to add an item sent (one open per
 * key), the company's matches remembered, each row's outcome kept, every
 * offer's change in the journal as the employee's «из прайса», and the
 * import `applied` with the result. Orders keep their snapshots: nothing
 * here touches them. A run that finds the import no longer `applying`
 * (applied already) does nothing — a retry never applies twice.
 */
@Injectable()
export class PriceImportApplier implements JobHandler<{ importId: string }> {
  private readonly logger = new Logger("PriceImports");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(AuditLog) private readonly audit: AuditLog,
  ) {}

  async run({ importId }: { importId: string }): Promise<void> {
    const startedAt = Date.now();
    const phases: Record<string, number> = {};
    let mark = startedAt;
    const lap = (phase: string) => {
      phases[phase] = Date.now() - mark;
      mark = Date.now();
    };
    const outcome = await this.database.db.transaction(async (tx) => {
      const [record] = await tx
        .select()
        .from(priceImport)
        .where(eq(priceImport.id, importId))
        .for("update");
      if (!record || record.status !== "applying" || !record.appliedByMemberId) return null;
      const context = await loadPlan(tx, record, this.settings, true);
      lap("plan");
      if (context.supplier.status === "blocked") {
        // Blocked between the request and the run (D-070): nothing is applied.
        await tx
          .update(priceImport)
          .set({
            status: "review",
            appliedAt: null,
            appliedByMemberId: null,
            version: record.version + 1,
            updatedAt: new Date(),
          })
          .where(eq(priceImport.id, importId));
        return "blocked" as const;
      }
      const [member] = await tx
        .select({ accountId: supplierMember.accountId })
        .from(supplierMember)
        .where(eq(supplierMember.id, record.appliedByMemberId));
      const actor: SupplierActor = {
        role: "supplier",
        accountId: member!.accountId,
        supplierId: record.supplierId,
        memberId: record.appliedByMemberId,
      };
      const result = await this.apply(tx, record, context.plans, context.point.id, actor, lap);
      await tx
        .update(priceImport)
        .set({ status: "applied", result, updatedAt: new Date() })
        .where(eq(priceImport.id, importId));
      await this.audit.record(
        {
          action: auditActions.priceImportApplied,
          actor,
          entityType: auditEntities.priceImport,
          entityId: importId,
          after: { ...result, supplierId: record.supplierId },
        },
        tx,
      );
      return result;
    });
    if (outcome === "blocked") {
      this.logger.warn(`Price list not applied: the company is blocked import=${importId}`);
    } else if (outcome) {
      this.logger.log(
        `Price list applied import=${importId} created=${String(outcome.created)} updated=${String(outcome.updated)} returned=${String(outcome.returned)} withdrawn=${String(outcome.withdrawnOutOfStock + outcome.withdrawnMissing)} requested=${String(outcome.requested)} durationMs=${String(Date.now() - startedAt)} phasesMs=${Object.entries(
          phases,
        )
          .map(([phase, ms]) => `${phase}:${String(ms)}`)
          .join(",")}`,
      );
    }
  }

  private async apply(
    tx: DbExecutor,
    record: PriceImportRecord,
    plans: readonly RowPlan[],
    locationId: string,
    actor: SupplierActor,
    lap: (phase: string) => void,
  ): Promise<PriceImportResult> {
    const now = new Date();
    const journal: AuditEntryInput[] = [];
    const fromImport = { source: "price_import", importId: record.id };
    const outcomes: {
      row_no: number;
      outcome: string;
      reason: string | null;
      offer_id: string | null;
    }[] = [];
    const notApplied = new Map<PriceRowNotAppliedReason, number>();
    let skipped = 0;

    // New offers.
    const creates = plans.flatMap((plan) => (plan.action.kind === "create" ? [plan] : []));
    const createdIds = new Map<string, string>();
    for (const chunk of chunks(creates)) {
      const payload = chunk.map((plan) => {
        const action = plan.action as Extract<RowPlan["action"], { kind: "create" }>;
        return {
          item_id: action.itemId,
          price: action.price,
          availability: action.terms.availability,
          lead_days: action.terms.leadDays,
          pickup: action.terms.pickup,
          delivery: action.terms.delivery,
          supplier_sku: action.change.supplierSku,
          supplier_raw_name: action.change.supplierRawName,
        };
      });
      const inserted = await tx.execute<{ id: string; item_id: string }>(sql`
        INSERT INTO offer (supplier_id, location_id, item_id, item_type, price, availability, lead_days,
          pickup, delivery, supplier_sku, supplier_raw_name, last_import_id, last_seen_in_import_at,
          created_by_member_id, updated_by_member_id)
        SELECT ${record.supplierId}::uuid, ${locationId}::uuid, x.item_id, i.item_type, x.price,
          x.availability, x.lead_days, x.pickup, x.delivery, x.supplier_sku, x.supplier_raw_name,
          ${record.id}::uuid, ${now}, ${actor.memberId}::uuid, ${actor.memberId}::uuid
        FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb)
          AS x(item_id uuid, price int, availability text, lead_days smallint, pickup boolean,
               delivery boolean, supplier_sku text, supplier_raw_name text)
        JOIN catalog_item i ON i.id = x.item_id
        RETURNING id, item_id`);
      for (const row of inserted.rows) createdIds.set(row.item_id, row.id);
    }
    for (const plan of creates) {
      const action = plan.action as Extract<RowPlan["action"], { kind: "create" }>;
      const offerId = createdIds.get(action.itemId)!;
      outcomes.push({
        row_no: plan.row.rowNo,
        outcome: "created",
        reason: null,
        offer_id: offerId,
      });
      journal.push({
        action: auditActions.offerCreated,
        actor,
        entityType: auditEntities.offer,
        entityId: offerId,
        after: {
          itemId: action.itemId,
          locationId,
          price: action.price,
          availability: action.terms.availability,
          leadDays: action.terms.leadDays,
          pickup: action.terms.pickup,
          delivery: action.terms.delivery,
          supplierSku: action.change.supplierSku,
          supplierName: action.change.supplierRawName,
          ...fromImport,
        },
      });
    }

    lap("create");
    // Offers changed: the fields, the status, the version.
    const updates = plans.flatMap((plan) => (plan.action.kind === "update" ? [plan] : []));
    for (const chunk of chunks(updates)) {
      const payload = chunk.map((plan) => {
        const action = plan.action as Extract<RowPlan["action"], { kind: "update" }>;
        return {
          id: action.offer.id,
          price: action.change.price,
          availability: action.change.availability,
          lead_days: action.change.leadDays,
          supplier_sku: action.change.supplierSku,
          supplier_raw_name: action.change.supplierRawName,
          status: action.change.status,
          withdrawn_reason: action.change.withdrawnReason,
          status_changed: action.withdrawn || action.returned,
        };
      });
      await tx.execute(sql`
        UPDATE offer o
        SET price = x.price, availability = x.availability, lead_days = x.lead_days,
            supplier_sku = x.supplier_sku, supplier_raw_name = x.supplier_raw_name,
            status = x.status, withdrawn_reason = x.withdrawn_reason,
            withdrawn_at = CASE WHEN x.status = 'withdrawn' THEN
              (CASE WHEN x.status_changed THEN ${now} ELSE o.withdrawn_at END) ELSE NULL END,
            version = o.version + 1, updated_by_member_id = ${actor.memberId}::uuid,
            updated_at = ${now}, last_import_id = ${record.id}::uuid, last_seen_in_import_at = ${now}
        FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb)
          AS x(id uuid, price int, availability text, lead_days smallint, supplier_sku text,
               supplier_raw_name text, status text, withdrawn_reason text, status_changed boolean)
        WHERE o.id = x.id`);
    }
    let updated = 0;
    let returned = 0;
    let withdrawnOutOfStock = 0;
    for (const plan of updates) {
      const action = plan.action as Extract<RowPlan["action"], { kind: "update" }>;
      const { offer, change } = action;
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      const fields = [
        ["price", offer.price, change.price],
        ["availability", offer.availability, change.availability],
        ["leadDays", offer.leadDays, change.leadDays],
        ["supplierSku", offer.supplierSku, change.supplierSku],
        ["supplierName", offer.supplierRawName, change.supplierRawName],
      ] as const;
      for (const [field, was, now] of fields) {
        if (was !== now) {
          before[field] = was;
          after[field] = now;
        }
      }
      if (Object.keys(after).length > 0) {
        journal.push({
          action: auditActions.offerChanged,
          actor,
          entityType: auditEntities.offer,
          entityId: offer.id,
          before,
          after: { ...after, ...fromImport },
        });
      }
      if (action.withdrawn) {
        withdrawnOutOfStock++;
        journal.push({
          action: auditActions.offerWithdrawn,
          actor,
          entityType: auditEntities.offer,
          entityId: offer.id,
          before: { status: offer.status },
          after: { status: "withdrawn", reason: "out_of_stock_in_import", ...fromImport },
        });
      } else if (action.returned) {
        returned++;
        journal.push({
          action: auditActions.offerReturned,
          actor,
          entityType: auditEntities.offer,
          entityId: offer.id,
          before: { status: offer.status, reason: offer.withdrawnReason },
          after: { status: "active", ...fromImport },
        });
      } else {
        updated++;
      }
      outcomes.push({
        row_no: plan.row.rowNo,
        outcome: action.withdrawn ? "withdrawn" : action.returned ? "returned" : "updated",
        reason: null,
        offer_id: offer.id,
      });
    }

    lap("update");
    // Offers the file confirmed as they were: only seen in this import.
    const unchanged = plans.flatMap((plan) =>
      plan.action.kind === "unchanged" ? [{ plan, offerId: plan.action.offer.id }] : [],
    );
    for (const chunk of chunks(unchanged)) {
      await tx.execute(sql`
        UPDATE offer SET last_import_id = ${record.id}::uuid, last_seen_in_import_at = ${now}
        WHERE id = ANY(${`{${chunk.map((entry) => entry.offerId).join(",")}}`}::uuid[])`);
    }
    for (const { plan, offerId } of unchanged) {
      outcomes.push({
        row_no: plan.row.rowNo,
        outcome: "unchanged",
        reason: null,
        offer_id: offerId,
      });
    }

    lap("unchanged");
    // «Пропали из файла» with «Снять с продажи».
    let withdrawnMissing = 0;
    if (record.missingAction === "withdraw") {
      const missing = await tx.execute<MissingOfferRow>(missingOffersQuery(record));
      for (const chunk of chunks(missing.rows)) {
        const done = await tx.execute<{ id: string; version: number }>(sql`
          UPDATE offer
          SET status = 'withdrawn', withdrawn_at = ${now}, withdrawn_reason = 'missing_in_import',
              version = version + 1, updated_by_member_id = ${actor.memberId}::uuid, updated_at = ${now}
          WHERE id = ANY(${`{${chunk.map((row) => row.id).join(",")}}`}::uuid[]) AND status = 'active'
          RETURNING id, version`);
        withdrawnMissing += done.rows.length;
        for (const row of done.rows) {
          journal.push({
            action: auditActions.offerWithdrawn,
            actor,
            entityType: auditEntities.offer,
            entityId: row.id,
            before: { status: "active" },
            after: {
              status: "withdrawn",
              reason: "missing_in_import",
              version: row.version,
              ...fromImport,
            },
          });
        }
      }
    }

    lap("missing");
    // Requests to add an item: one open per key of the company.
    const requests = plans.flatMap((plan) => (plan.action.kind === "request" ? [plan] : []));
    let requested = 0;
    for (const chunk of chunks(requests)) {
      const payload = chunk.map((plan) => {
        const parsed = plan.row.parsed;
        const data: CatalogRequestPayload = {
          article: parsed.article,
          articleNorm: parsed.articleNorm,
          brand: parsed.brand,
          name: parsed.name,
          price: parsed.price,
          availability: parsed.availability,
          leadDays: parsed.leadDays,
        };
        return { row_no: plan.row.rowNo, kind: plan.row.keyKind, key: plan.row.key, payload: data };
      });
      const inserted = await tx.execute<{ id: string; row_no: number }>(sql`
        INSERT INTO catalog_request (supplier_id, import_id, row_no, key_kind, key, payload, created_by_member_id)
        SELECT ${record.supplierId}::uuid, ${record.id}::uuid, x.row_no, x.kind, x.key, x.payload,
          ${actor.memberId}::uuid
        FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb)
          AS x(row_no int, kind text, key text, payload jsonb)
        ON CONFLICT (supplier_id, type, key_kind, key) WHERE status = 'new' DO NOTHING
        RETURNING id, row_no`);
      requested += inserted.rows.length;
      for (const row of inserted.rows) {
        journal.push({
          action: auditActions.catalogRequestCreated,
          actor,
          entityType: auditEntities.catalogRequest,
          entityId: row.id,
          after: { importId: record.id, rowNo: row.row_no },
        });
      }
    }
    for (const plan of requests) {
      outcomes.push({ row_no: plan.row.rowNo, outcome: "requested", reason: null, offer_id: null });
    }

    for (const plan of plans) {
      if (plan.action.kind === "skipped") {
        skipped++;
        outcomes.push({ row_no: plan.row.rowNo, outcome: "skipped", reason: null, offer_id: null });
      } else if (plan.action.kind === "not_applied") {
        notApplied.set(plan.action.reason, (notApplied.get(plan.action.reason) ?? 0) + 1);
        outcomes.push({
          row_no: plan.row.rowNo,
          outcome: "not_applied",
          reason: plan.action.reason,
          offer_id: null,
        });
      }
    }

    lap("requests");
    await this.remember(tx, record, plans, actor.memberId, now);
    lap("memory");
    for (const chunk of chunks(outcomes)) {
      await tx.execute(sql`
        UPDATE price_import_row r
        SET outcome = x.outcome, outcome_reason = x.reason, outcome_offer_id = x.offer_id
        FROM jsonb_to_recordset(${JSON.stringify(chunk)}::jsonb)
          AS x(row_no int, outcome text, reason text, offer_id uuid)
        WHERE r.import_id = ${record.id} AND r.row_no = x.row_no`);
    }
    lap("rows");
    await this.audit.recordMany(journal, tx);
    lap("journal");
    return {
      updated,
      created: creates.length,
      unchanged: unchanged.length,
      returned,
      withdrawnOutOfStock,
      withdrawnMissing,
      requested,
      notApplied: [...notApplied].map(([reason, rows]) => ({ reason, rows })),
      skipped,
    };
  }

  /**
   * The company's memory of its rows (ARCHITECTURE 12.2): an item confirmed
   * by the supplier or found by the exact article, a row the supplier
   * skipped, an item the catalog doesn't have; a remembered match used now
   * is marked as used. The next price list finds them without AI.
   */
  private async remember(
    tx: DbExecutor,
    record: PriceImportRecord,
    plans: readonly RowPlan[],
    memberId: string,
    now: Date,
  ): Promise<void> {
    const writes = plans.flatMap((plan) => {
      const memory = plan.remember;
      if (!memory || "touch" in memory) return [];
      return [
        {
          kind: plan.row.keyKind,
          key: plan.row.key,
          decision: memory.decision,
          item_id: memory.decision === "item" ? memory.itemId : null,
          by: memory.decision === "item" ? memory.by : "supplier",
        },
      ];
    });
    for (const chunk of chunks(writes)) {
      await tx.execute(sql`
        INSERT INTO supplier_sku_mapping (supplier_id, key_kind, key, decision, item_id, confirmed_by,
          confirmed_by_member_id, import_id, confirmed_at, last_used_at)
        SELECT ${record.supplierId}::uuid, x.kind, x.key, x.decision, x.item_id, x.by,
          ${memberId}::uuid, ${record.id}::uuid, ${now}, ${now}
        FROM jsonb_to_recordset(${JSON.stringify(chunk)}::jsonb)
          AS x(kind text, key text, decision text, item_id uuid, by text)
        ON CONFLICT (supplier_id, key_kind, key) DO UPDATE SET
          decision = excluded.decision, item_id = excluded.item_id,
          confirmed_by = excluded.confirmed_by, confirmed_by_member_id = excluded.confirmed_by_member_id,
          confirmed_by_admin_id = NULL, import_id = excluded.import_id,
          confirmed_at = excluded.confirmed_at, last_used_at = excluded.last_used_at,
          updated_at = ${now}`);
    }
    const touched = plans.flatMap((plan) =>
      plan.remember && "touch" in plan.remember
        ? [{ kind: plan.row.keyKind, key: plan.row.key }]
        : [],
    );
    for (const chunk of chunks(touched)) {
      await tx.execute(sql`
        UPDATE supplier_sku_mapping m SET last_used_at = ${now}
        FROM jsonb_to_recordset(${JSON.stringify(chunk)}::jsonb) AS x(kind text, key text)
        WHERE m.supplier_id = ${record.supplierId} AND m.key_kind = x.kind AND m.key = x.key`);
    }
  }
}
