import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  auditActions,
  auditEntities,
  type VehicleImportOutcome,
  type VehicleImportPlan,
  type VehicleImportReason,
  type VehicleImportResult,
} from "@adclub/contracts";
import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { DatabaseService, type DbExecutor } from "../../../database";
import type { JobHandler, JobRunContext, JobRunOutcome, PeriodicJobHandler } from "../../../jobs";
import { AuditLog } from "../../audit";
import { AppSettings } from "../../settings";
import { nameKey, spellingsOf, VEHICLE_LOCK } from "../vehicle-common";
import { writeMakeSpellings, writeModelSpellings } from "../vehicle-hierarchy.service";
import { writeEngineSpellings } from "../vehicle-modifications.service";
import {
  vehicleEngine,
  vehicleGeneration,
  vehicleImport,
  vehicleImportRow,
  vehicleMake,
  vehicleModel,
  vehicleModification,
  type VehicleImportRecord,
  type VehicleImportRowRecord,
} from "../schema";
import {
  buildReport,
  commitRow,
  newSeenRows,
  placeholderIds,
  planRow,
  type CreatedIds,
  type PlannedRow,
  type RowPlan,
  type RowValues,
} from "./import-plan";
import { loadSnapshot } from "./import-snapshot";
import { isMalformed } from "./vehicle-import.service";

const OUTCOME_OF: Record<VehicleImportPlan, VehicleImportOutcome> = {
  create: "created",
  update: "updated",
  unchanged: "unchanged",
  rejected: "rejected",
};

function rowValues(row: VehicleImportRowRecord): RowValues | null {
  return isMalformed(row.values) ? null : (row.values as RowValues);
}

/** Whether the import has been at its current phase longer than the setting allows. */
function outOfTime(row: VehicleImportRecord, timeoutMinutes: number): boolean {
  return Date.now() - row.phaseStartedAt.getTime() > timeoutMinutes * 60_000;
}

/**
 * Checks the rows of an uploaded import and writes the report
 * (`vehicles.analyze-import`; ARCHITECTURE 4.24). The rows are planned in
 * file order against one snapshot of the catalog — a row sees what the
 * rows before it would create — and the plans are written in batches;
 * the import becomes `ready` only if it is still being checked (a
 * cancelled or expired one stays as it is). Repeating a run starts over
 * from the stored rows, so a retry can't leave half a report.
 */
@Injectable()
export class VehicleImportAnalyzer implements JobHandler<{ importId: string }> {
  private readonly logger = new Logger("VehicleImport");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AppSettings) private readonly settings: AppSettings,
  ) {}

  async run({ importId }: { importId: string }, context: JobRunContext): Promise<void> {
    const db = this.database.db;
    const [entry] = await db.select().from(vehicleImport).where(eq(vehicleImport.id, importId));
    if (entry?.status !== "parsing") {
      return;
    }
    const startedAt = Date.now();
    const [batchSize, timeout] = await Promise.all([
      this.settings.get("vehicle_import_batch_size"),
      this.settings.get("vehicle_import_timeout_minutes"),
    ]);
    const rows = await db
      .select()
      .from(vehicleImportRow)
      .where(eq(vehicleImportRow.importId, importId))
      .orderBy(asc(vehicleImportRow.rowNumber));
    const values = rows.map(rowValues);
    const snapshot = await loadSnapshot(db, values);
    const seen = newSeenRows();
    const planned: PlannedRow[] = rows.map((row, index) => {
      const own = values[index] ?? null;
      const plan = planRow(own, snapshot, seen);
      if (own) {
        commitRow(
          row.rowNumber,
          own,
          plan,
          placeholderIds(row.rowNumber, plan.needs),
          snapshot,
          seen,
        );
      }
      return { rowNumber: row.rowNumber, plan };
    });
    for (let at = 0; at < planned.length; at += batchSize) {
      if (context.signal.aborted || outOfTime(entry, timeout)) {
        this.logger.warn(`Vehicle import check stopped import=${importId}`);
        return;
      }
      await writePlans(db, importId, planned.slice(at, at + batchSize));
    }
    const report = buildReport(planned);
    const [ready] = await db
      .update(vehicleImport)
      .set({ status: "ready", report, analyzedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(vehicleImport.id, importId), eq(vehicleImport.status, "parsing")))
      .returning({ id: vehicleImport.id });
    this.logger.log(
      `Vehicle import checked import=${importId} ready=${String(Boolean(ready))} create=${report.create} update=${report.update} unchanged=${report.unchanged} rejected=${report.rejected} durationMs=${Date.now() - startedAt}`,
    );
  }
}

async function writePlans(
  executor: DbExecutor,
  importId: string,
  rows: readonly PlannedRow[],
): Promise<void> {
  const payload = rows.map(({ rowNumber, plan }) => ({
    row_number: rowNumber,
    planned: plan.action,
    reasons: plan.reasons,
    modification_id: plan.resolved?.modificationId ?? null,
  }));
  await executor.execute(sql`
    UPDATE vehicle_import_row r
    SET planned = x.planned, reasons = x.reasons, modification_id = x.modification_id,
        outcome = NULL, outcome_reasons = NULL
    FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb)
      AS x(row_number int, planned text, reasons jsonb, modification_id uuid)
    WHERE r.import_id = ${importId} AND r.row_number = x.row_number`);
}

interface RowOutcome {
  rowNumber: number;
  outcome: VehicleImportOutcome;
  reasons: VehicleImportReason[];
  modificationId: string | null;
}

/**
 * Applies a confirmed import (`vehicles.apply-import`; ARCHITECTURE 4.24).
 * Rows go in file order, `vehicle_import_batch_size` per transaction, each
 * batch under the vehicle lock and against the catalog as it is then: a
 * row is planned again by the same rules as the report, so a catalog
 * changed by hand since the report can't be damaged — the row's outcome
 * then differs from its plan and says why. A row the report rejected is
 * not applied. A run goes on from the rows without an outcome, so a retry
 * never applies a row twice; when none are left the import is `applied`
 * with its result, and the action journal says so for the administrator
 * who confirmed it.
 */
@Injectable()
export class VehicleImportApplier implements JobHandler<{ importId: string }> {
  private readonly logger = new Logger("VehicleImport");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(AuditLog) private readonly audit: AuditLog,
  ) {}

  async run({ importId }: { importId: string }, context: JobRunContext): Promise<void> {
    const startedAt = Date.now();
    for (;;) {
      const [batchSize, timeout] = await Promise.all([
        this.settings.get("vehicle_import_batch_size"),
        this.settings.get("vehicle_import_timeout_minutes"),
      ]);
      if (context.signal.aborted) {
        return;
      }
      const state = await this.database.db.transaction(async (tx) => {
        await tx.execute(VEHICLE_LOCK);
        const [entry] = await tx
          .select()
          .from(vehicleImport)
          .where(eq(vehicleImport.id, importId))
          .for("update");
        if (entry?.status !== "applying") {
          return "stopped" as const;
        }
        if (outOfTime(entry, timeout)) {
          this.logger.warn(`Vehicle import apply out of time import=${importId}`);
          return "stopped" as const;
        }
        const rows = await tx
          .select()
          .from(vehicleImportRow)
          .where(and(eq(vehicleImportRow.importId, importId), isNull(vehicleImportRow.outcome)))
          .orderBy(asc(vehicleImportRow.rowNumber))
          .limit(batchSize);
        if (rows.length === 0) {
          await this.finish(tx, entry);
          return "done" as const;
        }
        await this.applyBatch(tx, entry, rows);
        return "more" as const;
      });
      if (state !== "more") {
        if (state === "done") {
          this.logger.log(
            `Vehicle import applied import=${importId} durationMs=${Date.now() - startedAt}`,
          );
        }
        return;
      }
    }
  }

  private async applyBatch(
    tx: DbExecutor,
    entry: VehicleImportRecord,
    rows: readonly VehicleImportRowRecord[],
  ): Promise<void> {
    const values = rows.map(rowValues);
    const snapshot = await loadSnapshot(tx, values);
    const seen = newSeenRows();
    const outcomes: RowOutcome[] = [];
    for (const [index, row] of rows.entries()) {
      const own = values[index] ?? null;
      if (row.planned === "rejected" || own === null) {
        outcomes.push({
          rowNumber: row.rowNumber,
          outcome: "rejected",
          reasons: row.reasons ?? [],
          modificationId: null,
        });
        continue;
      }
      const plan = planRow(own, snapshot, seen);
      const created = plan.action === "rejected" ? {} : await this.write(tx, entry.id, plan);
      commitRow(row.rowNumber, own, plan, created, snapshot, seen);
      outcomes.push({
        rowNumber: row.rowNumber,
        outcome: OUTCOME_OF[plan.action],
        reasons: plan.reasons,
        modificationId: created.modificationId ?? plan.resolved?.modificationId ?? null,
      });
    }
    await tx.execute(sql`
      UPDATE vehicle_import_row r
      SET outcome = x.outcome, outcome_reasons = x.reasons, modification_id = x.modification_id
      FROM jsonb_to_recordset(${JSON.stringify(
        outcomes.map((outcome) => ({
          row_number: outcome.rowNumber,
          outcome: outcome.outcome,
          reasons: outcome.reasons,
          modification_id: outcome.modificationId,
        })),
      )}::jsonb) AS x(row_number int, outcome text, reasons jsonb, modification_id uuid)
      WHERE r.import_id = ${entry.id} AND r.row_number = x.row_number`);
  }

  /** Writes what a planned row creates or changes; returns the ids of what it created. */
  private async write(tx: DbExecutor, importId: string, plan: RowPlan): Promise<CreatedIds> {
    const { needs, resolved } = plan;
    const created: CreatedIds = {};
    let makeId = resolved!.makeId;
    if (needs.make) {
      const [make] = await tx.insert(vehicleMake).values({ source: "import" }).returning();
      makeId = make!.id;
      await writeMakeSpellings(tx, makeId, spellingsOf(needs.make.name, []));
      created.makeId = makeId;
    }
    let modelId = resolved!.modelId;
    if (needs.model) {
      const [model] = await tx
        .insert(vehicleModel)
        .values({ makeId, source: "import" })
        .returning();
      modelId = model!.id;
      await writeModelSpellings(tx, modelId, makeId, spellingsOf(needs.model.name, []));
      created.modelId = modelId;
    }
    let generationId = resolved!.generationId;
    if (needs.generation) {
      const [generation] = await tx
        .insert(vehicleGeneration)
        .values({
          modelId,
          name: needs.generation.name,
          nameKey: nameKey(needs.generation.name),
          yearFrom: needs.generation.yearFrom,
          yearTo: needs.generation.yearTo,
          source: "import",
        })
        .returning();
      generationId = generation!.id;
      created.generationId = generationId;
    }
    let engineId = resolved!.identity.engineId;
    if (needs.engine) {
      const [engine] = await tx
        .insert(vehicleEngine)
        .values({
          fuelId: needs.engine.fuelId,
          displacementL:
            needs.engine.displacementL === null ? null : needs.engine.displacementL.toFixed(2),
          powerHp: needs.engine.powerHp,
          source: "import",
        })
        .returning();
      engineId = engine!.id;
      await writeEngineSpellings(tx, engineId, spellingsOf(needs.engine.code, []));
      created.engineId = engineId;
    }
    if (plan.action === "create") {
      const [modification] = await tx
        .insert(vehicleModification)
        .values({
          ...resolved!.identity,
          generationId,
          engineId,
          market: resolved!.market,
          source: "import",
          importId,
        })
        .returning({ id: vehicleModification.id });
      created.modificationId = modification!.id;
    } else if (plan.action === "update") {
      await tx
        .update(vehicleModification)
        .set({
          market: resolved!.market,
          version: sql`${vehicleModification.version} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(vehicleModification.id, resolved!.modificationId!));
    }
    return created;
  }

  private async finish(tx: DbExecutor, entry: VehicleImportRecord): Promise<void> {
    const counts = await tx.execute<{
      outcome: VehicleImportOutcome;
      rows: number;
      differs: number;
    }>(sql`
      SELECT outcome, count(*)::int AS rows,
        count(*) FILTER (WHERE NOT (
          (planned = 'create' AND outcome = 'created') OR (planned = 'update' AND outcome = 'updated')
          OR (planned = 'unchanged' AND outcome = 'unchanged') OR (planned = 'rejected' AND outcome = 'rejected')
        ))::int AS differs
      FROM vehicle_import_row WHERE import_id = ${entry.id} GROUP BY outcome`);
    const result: VehicleImportResult = {
      created: 0,
      updated: 0,
      unchanged: 0,
      rejected: 0,
      differsFromReport: 0,
    };
    for (const row of counts.rows) {
      result[row.outcome] += row.rows;
      result.differsFromReport += row.differs;
    }
    await tx
      .update(vehicleImport)
      .set({
        status: "applied",
        result,
        appliedAt: new Date(),
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(vehicleImport.id, entry.id));
    await this.audit.record(
      {
        action: auditActions.vehicleImportApplied,
        actor: {
          role: "admin",
          adminId: entry.appliedByAdminId!,
          accountId: entry.appliedByAccountId!,
        },
        entityType: auditEntities.vehicleImport,
        entityId: entry.id,
        before: { status: "applying" },
        after: { status: "applied", ...result },
      },
      tx,
    );
  }
}

/**
 * Marks imports checked or applied for longer than
 * `vehicle_import_timeout_minutes` as failed (`vehicles.expire-imports`).
 * What was applied stays applied (every row says what it did); the
 * administrator sees the truth and can upload the file again — a repeated
 * import of the same rows creates nothing twice.
 */
@Injectable()
export class VehicleImportExpiry implements PeriodicJobHandler {
  private readonly logger = new Logger("VehicleImport");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(AuditLog) private readonly audit: AuditLog,
  ) {}

  async run(): Promise<JobRunOutcome> {
    const timeout = await this.settings.get("vehicle_import_timeout_minutes");
    const deadline = new Date(Date.now() - timeout * 60_000);
    const expired = await this.database.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(vehicleImport)
        .where(
          and(
            inArray(vehicleImport.status, ["parsing", "applying"]),
            lt(vehicleImport.phaseStartedAt, deadline),
          ),
        )
        .for("update", { skipLocked: true });
      for (const row of rows) {
        const error =
          row.status === "parsing"
            ? `The check took longer than ${timeout} minutes`
            : `Applying took longer than ${timeout} minutes; the rows applied before stay applied`;
        await tx
          .update(vehicleImport)
          .set({ status: "failed", error, finishedAt: new Date(), updatedAt: new Date() })
          .where(eq(vehicleImport.id, row.id));
        await this.audit.record(
          {
            action: auditActions.vehicleImportFailed,
            actor: { role: "system" },
            entityType: auditEntities.vehicleImport,
            entityId: row.id,
            before: { status: row.status },
            after: { status: "failed", error },
          },
          tx,
        );
      }
      return rows.length;
    });
    if (expired > 0) {
      this.logger.warn(`Vehicle imports expired count=${expired}`);
    }
    return { worked: expired > 0 };
  }
}
