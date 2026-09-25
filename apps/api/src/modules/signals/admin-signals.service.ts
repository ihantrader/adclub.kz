import { Inject, Injectable, Logger } from "@nestjs/common";
import type {
  AdminSignal,
  AdminSignalKind,
  AdminSignalListQuery,
  AdminSignalPage,
  AdminSignalPayload,
} from "@adclub/contracts";
import { and, count, desc, eq, sql, type SQL } from "drizzle-orm";
import { DatabaseService, type DbExecutor } from "../../database";
import { adminSignal, type AdminSignalRow } from "./schema";

/**
 * Signals to the administrator (ARCHITECTURE 5.11, 6.5, 4.32; SCREENS
 * A-HOME): a fact the server noticed that a person has to look at. The
 * server decides nothing by them — it only writes them down, once per
 * subject: raising the same open signal again counts it up and refreshes
 * its payload, so a supplier with twenty closes by an administrator is one
 * row saying twenty, not twenty rows.
 *
 * Raised inside the transaction of the action that noticed it, so a signal
 * and what it is about are never out of step.
 */
@Injectable()
export class AdminSignals {
  private readonly logger = new Logger("AdminSignals");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async raise(
    tx: DbExecutor,
    signal: {
      kind: AdminSignalKind;
      subjectType: "order" | "supplier";
      subjectId: string;
      payload: AdminSignalPayload;
      at: Date;
    },
  ): Promise<void> {
    await tx
      .insert(adminSignal)
      .values({
        kind: signal.kind,
        subjectType: signal.subjectType,
        subjectId: signal.subjectId,
        payload: signal.payload,
        firstSeenAt: signal.at,
        lastSeenAt: signal.at,
      })
      .onConflictDoUpdate({
        // The partial unique index of the open signals of one subject.
        target: [adminSignal.kind, adminSignal.subjectType, adminSignal.subjectId],
        targetWhere: eq(adminSignal.status, "open"),
        set: {
          payload: signal.payload,
          times: sql`${adminSignal.times} + 1`,
          lastSeenAt: signal.at,
        },
      });
    this.logger.log(`Signal raised kind=${signal.kind} subject=${signal.subjectId}`);
  }

  async page(query: AdminSignalListQuery): Promise<AdminSignalPage> {
    const conditions: SQL[] = [];
    if (query.kind) {
      conditions.push(eq(adminSignal.kind, query.kind));
    }
    if (query.status) {
      conditions.push(eq(adminSignal.status, query.status));
    }
    if (query.subjectId) {
      conditions.push(eq(adminSignal.subjectId, query.subjectId));
    }
    const filter = conditions.length > 0 ? and(...conditions)! : sql`true`;
    const [rows, [total]] = await Promise.all([
      this.database.db
        .select()
        .from(adminSignal)
        .where(filter)
        .orderBy(desc(adminSignal.lastSeenAt), desc(adminSignal.id))
        .limit(query.limit + 1)
        .offset(query.offset),
      this.database.db.select({ value: count() }).from(adminSignal).where(filter),
    ]);
    const page = rows.slice(0, query.limit);
    return {
      signals: page.map(view),
      total: total?.value ?? 0,
      nextOffset: rows.length > query.limit ? query.offset + query.limit : null,
    };
  }
}

function view(row: AdminSignalRow): AdminSignal {
  return {
    id: row.id,
    kind: row.kind,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    status: row.status,
    payload: row.payload,
    times: row.times,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
  };
}
