import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import type { AdminSignalPayload } from "@adclub/contracts";
import { inArray, sql } from "drizzle-orm";
import { DatabaseService, type DbExecutor } from "../../database";
import {
  definePeriodicJob,
  EVERY_MINUTE,
  JobRegistry,
  type JobRunOutcome,
  type PeriodicJobHandler,
} from "../../jobs";
import { supplier } from "../identity";
import { AdminSignals } from "../signals";
import { OrderNotices } from "./order-notices";
import { databaseNow } from "./order-transitions";
import {
  supplierReachVerdict,
  type RecipientReach,
  type SupplierReachVerdict,
} from "./supplier-reach-verdict";

/**
 * «Поставщик недостижим» (D-061; TASK-034 requirement 3; ARCHITECTURE 4.52;
 * SCREENS A-HOME). There is no other channel to a supplier than WhatsApp, so
 * a company whose every recipient of the notices of orders (by
 * `notificationRecipients`, as W-01 picks them) has no WhatsApp by the last
 * word about their number hears of no order at all. Every minute this
 * detector raises one signal per such company (`supplier_unreachable`,
 * subject — the supplier; the unique index keeps it one) and closes it by
 * itself as soon as a message reaches any of its recipients again. What a
 * number is decides `supplier-reach-verdict.ts`.
 *
 * What a closed signal told about is not told again: after an administrator
 * closed it, only a newer refusal opens another one for the company.
 *
 * It looks only at companies with an employee refused `no_whatsapp` in the
 * last days, and at the ones it has raised a signal about: a company
 * without such refusals is reachable as far as anyone knows.
 */

export const supplierReachWatchJob = definePeriodicJob({
  name: "orders.watch-supplier-reach",
  timeoutSeconds: 60,
  // The next run a minute later is the retry.
  retry: { limit: 0, delaySeconds: 0, backoff: false },
  singleton: true,
  schedule: () => EVERY_MINUTE,
});

const KIND = "supplier_unreachable" as const;

/** How far back a refusal makes a company worth judging. */
const LOOK_BACK_DAYS = 7;

function dateOf(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

/** Companies with an active employee whose number was refused `no_whatsapp` lately. */
async function suspectedSuppliers(executor: DbExecutor): Promise<string[]> {
  const result = await executor.execute<{ supplier_id: string }>(sql`
    SELECT DISTINCT sm.supplier_id
    FROM outbound_message m
    JOIN account a ON a.phone = m.phone
    JOIN supplier_member sm ON sm.account_id = a.id AND sm.status = 'active'
    WHERE m.status = 'failed' AND m.failure_kind = 'no_whatsapp'
      AND m.settled_at >= now() - make_interval(days => ${LOOK_BACK_DAYS})
  `);
  return result.rows.map((row) => row.supplier_id);
}

/**
 * The last decisive word about each number: delivered or read (with the
 * test channel — sent: it delivers nothing), or refused as `no_whatsapp`.
 */
async function lastWords(
  executor: DbExecutor,
  phones: readonly string[],
): Promise<Map<string, NonNullable<RecipientReach["last"]>>> {
  const words = new Map<string, NonNullable<RecipientReach["last"]>>();
  if (phones.length === 0) {
    return words;
  }
  const result = await executor.execute<{ phone: string; kind: string; at: unknown }>(sql`
    SELECT DISTINCT ON (phone) phone, kind, at FROM (
      SELECT m.phone,
        CASE WHEN m.status = 'failed' THEN 'no_whatsapp' ELSE 'delivered' END AS kind,
        CASE
          WHEN m.status IN ('delivered', 'read') THEN coalesce(m.delivered_at, m.read_at, m.settled_at)
          WHEN m.status = 'sent' THEN m.sent_at
          ELSE m.settled_at
        END AS at
      FROM outbound_message m
      WHERE m.phone = ANY(${`{${phones.join(",")}}`}::text[])
        AND (
          m.status IN ('delivered', 'read')
          OR (m.status = 'sent' AND m.provider = 'test')
          OR (m.status = 'failed' AND m.failure_kind = 'no_whatsapp')
        )
    ) words
    WHERE at IS NOT NULL
    ORDER BY phone, at DESC
  `);
  for (const row of result.rows) {
    words.set(row.phone, {
      kind: row.kind === "no_whatsapp" ? "no_whatsapp" : "delivered",
      at: dateOf(row.at),
    });
  }
  return words;
}

@Injectable()
export class SupplierReachWatch implements PeriodicJobHandler, OnModuleInit {
  private readonly logger = new Logger("SupplierReach");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(JobRegistry) private readonly registry: JobRegistry,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AdminSignals) private readonly signals: AdminSignals,
    @Inject(OrderNotices) private readonly notices: OrderNotices,
  ) {}

  onModuleInit(): void {
    this.registry.handlePeriodic(supplierReachWatchJob, this);
  }

  async run(): Promise<JobRunOutcome> {
    return this.database.db.transaction(async (tx) => {
      // One judgement at a time, whoever runs it (the schedule, `jobs:run`).
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('orders.watch-supplier-reach'))`);
      const at = await databaseNow(tx);
      const current = await this.signals.openOfKind(tx, KIND);
      const ids = [
        ...new Set([...(await suspectedSuppliers(tx)), ...current.map((row) => row.subjectId)]),
      ];
      if (ids.length === 0) {
        return { worked: false };
      }
      const names = new Map(
        (
          await tx
            .select({ id: supplier.id, name: supplier.name })
            .from(supplier)
            .where(inArray(supplier.id, ids))
        ).map((row) => [row.id, row.name]),
      );
      let worked = false;
      for (const supplierId of ids) {
        const recipients = await this.notices.recipients(tx, supplierId);
        const words = await lastWords(
          tx,
          recipients.map((member) => member.phone),
        );
        const verdict = supplierReachVerdict(
          recipients.map((member) => ({
            memberId: member.id,
            last: words.get(member.phone) ?? null,
          })),
        );
        const open = current.find((row) => row.subjectId === supplierId);
        const payload: AdminSignalPayload = {
          supplierId,
          supplierName: names.get(supplierId),
          recipients: recipients.length,
          recipientsWithoutWhatsapp: verdict.withoutWhatsapp,
          since: (open?.payload.since ?? verdict.firstFailureAt?.toISOString()) || undefined,
          lastFailureAt: verdict.lastFailureAt?.toISOString(),
        };
        if (verdict.unreachable && !open && (await this.toldAlready(tx, supplierId, verdict))) {
          // A closed signal already told about these very refusals (the
          // administrator dealt with it): only a newer refusal opens another.
          continue;
        }
        if (verdict.unreachable) {
          const before = open?.payload;
          const changed =
            !open ||
            before?.lastFailureAt !== payload.lastFailureAt ||
            before?.recipients !== payload.recipients;
          if (changed) {
            await this.signals.raise(tx, {
              kind: KIND,
              subjectType: "supplier",
              subjectId: supplierId,
              payload,
              at,
            });
            worked = true;
            if (!open) {
              this.logger.warn(
                `Supplier unreachable supplier=${supplierId} recipients=${String(recipients.length)}`,
              );
            }
          }
        } else if (open && verdict.reachedAt) {
          // A message reached the company again: the fact is over.
          await this.signals.close(tx, {
            kind: KIND,
            subjectType: "supplier",
            subjectId: supplierId,
            payload: { ...open.payload, ...payload, endedAt: verdict.reachedAt.toISOString() },
            at,
          });
          this.logger.log(`Supplier reachable again supplier=${supplierId}`);
          worked = true;
        }
      }
      return { worked };
    });
  }

  /** Whether the latest closed signal of the company told about the latest refusal already. */
  private async toldAlready(
    tx: DbExecutor,
    supplierId: string,
    verdict: SupplierReachVerdict,
  ): Promise<boolean> {
    const closed = await this.signals.lastClosedOf(tx, KIND, "supplier", supplierId);
    const told = closed?.payload.lastFailureAt;
    return (
      told !== undefined &&
      verdict.lastFailureAt !== null &&
      verdict.lastFailureAt <= new Date(told)
    );
  }
}
