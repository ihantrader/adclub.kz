import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  adminSignalKindSchema,
  auditActions,
  auditEntities,
  type AdminSignal,
  type AdminSignalActor,
  type AdminSignalKind,
  type AdminSignalListQuery,
  type AdminSignalPage,
  type AdminSignalPayload,
  type AdminSignalStatus,
  type AdminSignalSubject,
} from "@adclub/contracts";
import { and, count, desc, eq, ne, sql, type SQL } from "drizzle-orm";
import { ApiException } from "../../common/errors";
import { DatabaseService, type DbExecutor } from "../../database";
import { AuditLog } from "../audit";
import { AccountDirectory, type ShownPerson } from "../identity";
import { adminSignal, type AdminSignalRow } from "./schema";

/** The administrator acting on a signal (TASK-034). */
export interface SignalActor {
  adminId: string;
  accountId: string;
}

/** Not closed: new or in work — the one current signal of its subject. */
const notClosed = ne(adminSignal.status, "closed");

/**
 * Signals to the administrator (ARCHITECTURE 5.11, 6.5, 4.32, 4.52; SCREENS
 * A-HOME, A-SIG): a fact the server noticed that a person has to look at.
 * The server decides nothing by them — it only writes them down, once per
 * subject: raising the same signal again while it is not closed counts it
 * up and refreshes its payload, so a supplier with twenty closes by an
 * administrator is one row saying twenty, not twenty rows.
 *
 * Raised inside the transaction of the action that noticed it, so a signal
 * and what it is about are never out of step. An administrator takes it in
 * work and closes it with a comment (TASK-034), each time with the version
 * they saw; a fact that is over closes its signal by itself.
 */
@Injectable()
export class AdminSignals {
  private readonly logger = new Logger("AdminSignals");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditLog) private readonly audit: AuditLog,
    @Inject(AccountDirectory) private readonly accounts: AccountDirectory,
  ) {}

  async raise(
    tx: DbExecutor,
    signal: {
      kind: AdminSignalKind;
      subjectType: AdminSignalSubject;
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
        // The partial unique index of the signals of one subject that are not closed.
        target: [adminSignal.kind, adminSignal.subjectType, adminSignal.subjectId],
        targetWhere: notClosed,
        // The status and the version stay: a signal in work stays in work,
        // and an administrator about to close it is not refused for a fact
        // that only came up again.
        set: {
          payload: signal.payload,
          times: sql`${adminSignal.times} + 1`,
          lastSeenAt: signal.at,
        },
      });
    this.logger.log(`Signal raised kind=${signal.kind} subject=${signal.subjectId}`);
  }

  /** The signal of a kind about a subject that is not closed (new or in work), if there is one. */
  async openOf(
    executor: DbExecutor,
    kind: AdminSignalKind,
    subjectType: AdminSignalSubject,
    subjectId: string,
  ): Promise<AdminSignalRow | undefined> {
    const [row] = await executor
      .select()
      .from(adminSignal)
      .where(
        and(
          eq(adminSignal.kind, kind),
          eq(adminSignal.subjectType, subjectType),
          eq(adminSignal.subjectId, subjectId),
          notClosed,
        ),
      );
    return row;
  }

  /** Every signal of a kind that is not closed (the detectors look at what they raised). */
  async openOfKind(executor: DbExecutor, kind: AdminSignalKind): Promise<AdminSignalRow[]> {
    return executor
      .select()
      .from(adminSignal)
      .where(and(eq(adminSignal.kind, kind), notClosed));
  }

  /** The latest closed signal of a kind about a subject, if there is one. */
  async lastClosedOf(
    executor: DbExecutor,
    kind: AdminSignalKind,
    subjectType: AdminSignalSubject,
    subjectId: string,
  ): Promise<AdminSignalRow | undefined> {
    const [row] = await executor
      .select()
      .from(adminSignal)
      .where(
        and(
          eq(adminSignal.kind, kind),
          eq(adminSignal.subjectType, subjectType),
          eq(adminSignal.subjectId, subjectId),
          eq(adminSignal.status, "closed"),
        ),
      )
      .orderBy(desc(adminSignal.closedAt))
      .limit(1);
    return row;
  }

  /**
   * Closes the signal of a kind about a subject that is not closed — the
   * fact is over (TASK-025: the channel delivers again; TASK-034: the
   * supplier is reachable again). The row stays as history with its last
   * payload; a later fact of the same kind opens a new one.
   */
  async close(
    tx: DbExecutor,
    signal: {
      kind: AdminSignalKind;
      subjectType: AdminSignalSubject;
      subjectId: string;
      payload: AdminSignalPayload;
      at: Date;
    },
  ): Promise<boolean> {
    const closed = await tx
      .update(adminSignal)
      .set({
        status: "closed",
        closedAt: signal.at,
        payload: signal.payload,
        version: sql`${adminSignal.version} + 1`,
      })
      .where(
        and(
          eq(adminSignal.kind, signal.kind),
          eq(adminSignal.subjectType, signal.subjectType),
          eq(adminSignal.subjectId, signal.subjectId),
          notClosed,
        ),
      )
      .returning({ id: adminSignal.id });
    if (closed.length > 0) {
      this.logger.log(`Signal closed kind=${signal.kind} subject=${signal.subjectId}`);
    }
    return closed.length > 0;
  }

  /**
   * «Взять в работу» (A-SIG): a new signal becomes «в работе». Another
   * version, or a signal no longer new — `SIGNAL_CONFLICT` with the signal
   * as it is now; nothing changes.
   */
  async acknowledge(
    signalId: string,
    expectedVersion: number,
    actor: SignalActor,
  ): Promise<AdminSignal> {
    const row = await this.database.db.transaction(async (tx) => {
      const current = await this.lock(tx, signalId);
      if (current.version !== expectedVersion || current.status !== "open") {
        return { conflict: current };
      }
      const [updated] = await tx
        .update(adminSignal)
        .set({
          status: "acknowledged",
          acknowledgedAt: sql`now()`,
          acknowledgedByAdminId: actor.adminId,
          version: sql`${adminSignal.version} + 1`,
        })
        .where(eq(adminSignal.id, signalId))
        .returning();
      await this.audit.record(
        {
          action: auditActions.adminSignalAcknowledged,
          actor: { role: "admin", accountId: actor.accountId, adminId: actor.adminId },
          entityType: auditEntities.adminSignal,
          entityId: signalId,
          before: { kind: current.kind, status: current.status, version: current.version },
          after: { status: updated!.status, version: updated!.version },
        },
        tx,
      );
      return { updated: updated! };
    });
    if (row.conflict) {
      throw await this.conflict(row.conflict);
    }
    this.logger.log(`Signal acknowledged signal=${signalId} by=admin:${actor.adminId}`);
    return this.viewOne(row.updated!);
  }

  /**
   * «Закрыть с комментарием» (A-SIG): a new signal or one in work is closed
   * by the administrator; the comment goes into the action journal as the
   * reason. Already closed (by a colleague or by the server) or another
   * version — `SIGNAL_CONFLICT` «уже закрыт {кем}».
   */
  async closeByAdmin(
    signalId: string,
    expectedVersion: number,
    comment: string,
    actor: SignalActor,
  ): Promise<AdminSignal> {
    const text = comment.trim();
    const row = await this.database.db.transaction(async (tx) => {
      const current = await this.lock(tx, signalId);
      if (current.version !== expectedVersion || current.status === "closed") {
        return { conflict: current };
      }
      const [updated] = await tx
        .update(adminSignal)
        .set({
          status: "closed",
          closedAt: sql`now()`,
          closedByAdminId: actor.adminId,
          closeComment: text,
          version: sql`${adminSignal.version} + 1`,
        })
        .where(eq(adminSignal.id, signalId))
        .returning();
      await this.audit.record(
        {
          action: auditActions.adminSignalClosed,
          actor: { role: "admin", accountId: actor.accountId, adminId: actor.adminId },
          entityType: auditEntities.adminSignal,
          entityId: signalId,
          before: { kind: current.kind, status: current.status, version: current.version },
          after: { status: updated!.status, version: updated!.version },
          reason: text,
        },
        tx,
      );
      return { updated: updated! };
    });
    if (row.conflict) {
      throw await this.conflict(row.conflict);
    }
    this.logger.log(`Signal closed signal=${signalId} by=admin:${actor.adminId}`);
    return this.viewOne(row.updated!);
  }

  async page(query: AdminSignalListQuery): Promise<AdminSignalPage> {
    const conditions: SQL[] = [];
    if (query.kind) {
      conditions.push(eq(adminSignal.kind, query.kind));
    }
    if (query.status === "current") {
      conditions.push(notClosed);
    } else if (query.status) {
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
      signals: await this.view(page),
      total: total?.value ?? 0,
      nextOffset: rows.length > query.limit ? query.offset + query.limit : null,
    };
  }

  /** Signals that are not closed, by kind and status — every kind, zeros too (A-HOME). */
  async currentCounts(): Promise<{ kind: AdminSignalKind; open: number; acknowledged: number }[]> {
    const rows = await this.database.db
      .select({ kind: adminSignal.kind, status: adminSignal.status, value: count() })
      .from(adminSignal)
      .where(notClosed)
      .groupBy(adminSignal.kind, adminSignal.status);
    return adminSignalKindSchema.options.map((kind) => ({
      kind,
      open: rows.find((row) => row.kind === kind && row.status === "open")?.value ?? 0,
      acknowledged:
        rows.find((row) => row.kind === kind && row.status === "acknowledged")?.value ?? 0,
    }));
  }

  /** The current outage of the channel of notices, if there is one (A-HOME, 1). */
  async currentOfKind(kind: AdminSignalKind): Promise<AdminSignalRow | undefined> {
    const [row] = await this.database.db
      .select()
      .from(adminSignal)
      .where(and(eq(adminSignal.kind, kind), notClosed))
      .orderBy(desc(adminSignal.lastSeenAt))
      .limit(1);
    return row;
  }

  private async lock(tx: DbExecutor, signalId: string): Promise<AdminSignalRow> {
    const [row] = await tx
      .select()
      .from(adminSignal)
      .where(eq(adminSignal.id, signalId))
      .for("update");
    if (!row) {
      throw new ApiException(404, "NOT_FOUND", "Signal not found");
    }
    return row;
  }

  private async conflict(row: AdminSignalRow): Promise<ApiException> {
    const signal = await this.viewOne(row);
    this.logger.warn(
      `Signal action refused: changed meanwhile signal=${row.id} status=${row.status} version=${String(row.version)}`,
    );
    return new ApiException(
      409,
      "SIGNAL_CONFLICT",
      "The signal was changed meanwhile; nothing was written",
      { details: { signal } },
    );
  }

  private async viewOne(row: AdminSignalRow): Promise<AdminSignal> {
    const [signal] = await this.view([row]);
    return signal!;
  }

  private async view(rows: readonly AdminSignalRow[]): Promise<AdminSignal[]> {
    const admins = await this.accounts.administrators(
      rows.flatMap((row) =>
        [row.acknowledgedByAdminId, row.closedByAdminId].filter((id): id is string => !!id),
      ),
    );
    return rows.map((row) => toSignal(row, admins));
  }
}

function adminActor(
  adminId: string | null,
  admins: Map<string, ShownPerson>,
): AdminSignalActor | null {
  if (!adminId) {
    return null;
  }
  const person = admins.get(adminId);
  return {
    kind: "admin",
    adminId,
    name: person?.name ?? null,
    phoneMasked: person?.phoneMasked ?? null,
  };
}

const SYSTEM: AdminSignalActor = { kind: "system", adminId: null, name: null, phoneMasked: null };

function toSignal(row: AdminSignalRow, admins: Map<string, ShownPerson>): AdminSignal {
  const closed = row.status === ("closed" satisfies AdminSignalStatus);
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
    closedAt: row.closedAt?.toISOString() ?? null,
    version: row.version,
    acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
    acknowledgedBy: adminActor(row.acknowledgedByAdminId, admins),
    closedBy: closed ? (adminActor(row.closedByAdminId, admins) ?? SYSTEM) : null,
    closeComment: row.closeComment,
  };
}
