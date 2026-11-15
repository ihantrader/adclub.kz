import { Inject, Injectable, Logger } from "@nestjs/common";
import type {
  AdminSignalPayload,
  AdminSupplierViews,
  AdminSupplierViewsQuery,
  OfferViewFigures,
} from "@adclub/contracts";
import { ADMIN_SUPPLIER_VIEWS_MAX_DAYS } from "@adclub/contracts";
import { viewsConversion, viewsSignalMove, viewsSignalVerdicts } from "@adclub/domain";
import { eq, inArray, lt, sql } from "drizzle-orm";
import { ApiException } from "../../common/errors";
import { DatabaseService, type DbExecutor } from "../../database";
import { supplier } from "../identity";
import { AppSettings } from "../settings";
import { AdminSignals } from "../signals";
import { almatyDayOf } from "./offer-views";
import { offerViewEvent } from "./schema";
import { viewFacts, type ViewFacts } from "./view-facts";

const KIND = "views_orders_gap" as const;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Raw views deleted in one statement of the cleanup. */
const CLEANUP_BATCH = 10_000;

/** `YYYY-MM-DD` ± days, as a calendar (no time zone involved). */
export function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

function figuresOf(row: Pick<ViewFacts, "views" | "orders"> | undefined): OfferViewFigures {
  const views = row?.views ?? { guest: 0, user: 0, club: 0 };
  const orders = row?.orders ?? 0;
  return {
    club: views.club,
    user: views.user,
    guest: views.guest,
    total: views.club + views.user + views.guest,
    orders,
    conversion: viewsConversion(orders, views.club),
  };
}

/** The numbers of a signal's payload that a refresh would change. */
const SIGNAL_NUMBERS = [
  "views",
  "orders",
  "conversion",
  "medianConversion",
  "conversionThreshold",
  "suppliersInMedian",
  "windowDays",
  "periodFrom",
  "periodTo",
] as const satisfies readonly (keyof AdminSignalPayload)[];

function sameNumbers(before: AdminSignalPayload, after: AdminSignalPayload): boolean {
  return SIGNAL_NUMBERS.every((key) => before[key] === after[key]);
}

/**
 * The signal «Просмотров много, заявок мало» and the admin panel's view of
 * the views (TASK-070; ARCHITECTURE 4.88). The numbers — only `viewFacts`;
 * the rule — only `viewsSignalVerdicts` and `viewsSignalMove` of
 * `@adclub/domain`.
 */
@Injectable()
export class OfferViewsService {
  private readonly logger = new Logger("OfferViewsSignal");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(AdminSignals) private readonly signals: AdminSignals,
  ) {}

  async rules(): Promise<{
    windowDays: number;
    minViews: number;
    minSuppliers: number;
    ratio: number;
  }> {
    const [windowDays, minViews, minSuppliers, ratio] = await Promise.all([
      this.settings.get("views_signal_window_days"),
      this.settings.get("views_signal_min"),
      this.settings.get("views_signal_min_suppliers"),
      this.settings.get("views_signal_ratio"),
    ]);
    return { windowDays, minViews, minSuppliers, ratio };
  }

  /** Today of Almaty by the database's clock (one for every process). */
  private async today(executor: DbExecutor): Promise<{ day: string; now: Date }> {
    const result = await executor.execute<{ day: string; ms: string }>(
      sql`SELECT ((now() AT TIME ZONE 'Asia/Almaty')::date)::text AS day,
                 (extract(epoch FROM now()) * 1000)::text AS ms`,
    );
    const row = result.rows[0]!;
    return { day: row.day, now: new Date(Number(row.ms)) };
  }

  /**
   * `offers.views-signal`: the raw views past their term go, then every
   * supplier is judged over the window — the whole days up to yesterday —
   * and its signal opened, refreshed or closed. One transaction under one
   * lock: two workers (or a `jobs:run` next to the schedule) never interleave,
   * and a second run the same day changes nothing new.
   */
  async run(signal?: AbortSignal): Promise<{
    removed: number;
    judged: number;
    raised: number;
    closed: number;
  }> {
    const removed = await this.cleanup(signal);
    const rules = await this.rules();
    return this.database.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('offers.views-signal'))`);
      const { day: today, now } = await this.today(tx);
      const periodTo = shiftDay(today, -1);
      const periodFrom = shiftDay(today, -rules.windowDays);
      const facts = await viewFacts(tx, { from: periodFrom, to: periodTo, byDay: false });
      const outcome = viewsSignalVerdicts(
        facts.map((row) => ({
          supplierId: row.supplierId,
          clubViews: row.views.club,
          orders: row.orders,
        })),
        rules,
      );
      const verdicts = new Map(outcome.verdicts.map((entry) => [entry.supplierId, entry]));
      const open = await this.signals.openOfKind(tx, KIND);
      const openBySupplier = new Map(open.map((row) => [row.subjectId, row]));
      const subjects = [
        ...new Set([
          ...outcome.verdicts.filter((entry) => entry.gap).map((entry) => entry.supplierId),
          ...openBySupplier.keys(),
        ]),
      ];
      const names = new Map(
        subjects.length === 0
          ? []
          : (
              await tx
                .select({ id: supplier.id, name: supplier.name })
                .from(supplier)
                .where(inArray(supplier.id, subjects))
            ).map((row) => [row.id, row.name]),
      );
      let raised = 0;
      let closed = 0;
      for (const supplierId of subjects) {
        const verdict = verdicts.get(supplierId);
        const current = openBySupplier.get(supplierId);
        const lastClosed = current
          ? undefined
          : await this.signals.lastClosedOf(tx, KIND, "supplier", supplierId);
        const conversion = verdict?.conversion ?? null;
        const move = viewsSignalMove({
          gap: verdict?.gap ?? false,
          conversion,
          open: current !== undefined,
          lastClosed: lastClosed?.closedAt
            ? {
                byAdmin: lastClosed.closedByAdminId !== null,
                at: lastClosed.closedAt,
                conversion: lastClosed.payload.conversion ?? null,
              }
            : null,
          windowDays: rules.windowDays,
          now,
        });
        const payload: AdminSignalPayload = {
          supplierId,
          ...(names.has(supplierId) ? { supplierName: names.get(supplierId)! } : {}),
          views: verdict?.clubViews ?? 0,
          orders: verdict?.orders ?? 0,
          ...(conversion !== null ? { conversion } : {}),
          ...(outcome.median !== null ? { medianConversion: outcome.median } : {}),
          ...(outcome.threshold !== null ? { conversionThreshold: outcome.threshold } : {}),
          suppliersInMedian: outcome.suppliersInMedian,
          windowDays: rules.windowDays,
          periodFrom,
          periodTo,
        };
        if (move === "raise" || move === "refresh") {
          // A second run with the same numbers (the same day, nothing changed): nothing to refresh.
          if (move === "refresh" && current && sameNumbers(current.payload, payload)) {
            continue;
          }
          await this.signals.raise(tx, {
            kind: KIND,
            subjectType: "supplier",
            subjectId: supplierId,
            payload,
            at: now,
          });
          raised += move === "raise" ? 1 : 0;
        } else if (move === "close") {
          await this.signals.close(tx, {
            kind: KIND,
            subjectType: "supplier",
            subjectId: supplierId,
            // The numbers of now only: no conversion of before next to 0 views.
            payload: { ...payload, endedAt: now.toISOString() },
            at: now,
          });
          closed += 1;
        }
      }
      this.logger.log(
        `Views signal judged=${String(outcome.suppliersInMedian)} raised=${String(raised)} closed=${String(closed)} removed=${String(removed)} window=${periodFrom}..${periodTo}`,
      );
      return { removed, judged: outcome.suppliersInMedian, raised, closed };
    });
  }

  /** Deletes the raw views older than `offer_view_retention_days`, in batches. */
  async cleanup(signal?: AbortSignal): Promise<number> {
    const retention = await this.settings.get("offer_view_retention_days");
    const { day: today } = await this.today(this.database.db);
    const before = shiftDay(today, -retention);
    let removed = 0;
    for (;;) {
      if (signal?.aborted) {
        break;
      }
      const result = await this.database.db.execute(sql`
        DELETE FROM ${offerViewEvent}
        WHERE ctid IN (
          SELECT ctid FROM ${offerViewEvent} WHERE ${lt(offerViewEvent.day, before)} LIMIT ${CLEANUP_BATCH}
        )
      `);
      const count = result.rowCount ?? 0;
      removed += count;
      if (count < CLEANUP_BATCH) {
        break;
      }
    }
    return removed;
  }

  /** A-SUP-03 «Просмотры и заявки». */
  async adminView(supplierId: string, query: AdminSupplierViewsQuery): Promise<AdminSupplierViews> {
    const db = this.database.db;
    const [company] = await db
      .select({ id: supplier.id })
      .from(supplier)
      .where(eq(supplier.id, supplierId));
    if (!company) {
      throw new ApiException(404, "NOT_FOUND", "No such supplier");
    }
    const today = almatyDayOf(new Date());
    const to = query.to ?? today;
    const from = query.from ?? shiftDay(to, -29);
    if (from > to) {
      throw new ApiException(400, "VALIDATION_ERROR", "The period starts after it ends", {
        details: [{ path: "from", message: "The period starts after it ends" }],
      });
    }
    if (daysBetween(from, to) + 1 > ADMIN_SUPPLIER_VIEWS_MAX_DAYS) {
      throw new ApiException(400, "VALIDATION_ERROR", "The period is too long", {
        details: [
          { path: "from", message: `At most ${String(ADMIN_SUPPLIER_VIEWS_MAX_DAYS)} days` },
        ],
      });
    }
    const [daily, [total], rules] = await Promise.all([
      viewFacts(db, { from, to, supplierIds: [supplierId], byDay: true }),
      viewFacts(db, { from, to, supplierIds: [supplierId], byDay: false }),
      this.rules(),
    ]);
    const byDay = new Map(daily.map((row) => [row.day!, row]));
    const days: AdminSupplierViews["days"] = [];
    for (let day = from; day <= to; day = shiftDay(day, 1)) {
      days.push({ day, ...figuresOf(byDay.get(day)) });
    }
    return { from, to, days, total: figuresOf(total), signal: rules };
  }
}
