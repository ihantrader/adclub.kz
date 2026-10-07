import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  auditActions,
  auditEntities,
  type AdminCompatibilityRecord,
  type AdminItemCompatibilityResponse,
  type CompatibilityConditions,
  type CompatibilitySource,
  type CopyCompatibilityResponse,
  type CreateCompatibilityRecordBody,
  type UpdateCompatibilityRecordBody,
} from "@adclub/contracts";
import { and, asc, eq, or } from "drizzle-orm";
import { DatabaseService, type DbExecutor } from "../../database";
import { AuditLog, type AuditActorRecord } from "../audit";
import { itemAnalog } from "../catalog";
import { conditionsOf, resolveConditions, sameConditions } from "./compatibility-conditions";
import { duplicate, notAnalog, notFound, versionConflict } from "./compatibility-errors";
import {
  approvedMatch,
  assertWritable,
  describeAdminProposals,
  describeRecords,
  findItem,
  itemLock,
  VEHICLE_LOCK_SHARED,
} from "./compatibility-store";
import { itemCompatibility, itemCompatibilityProposal, type ItemCompatibilityRow } from "./schema";

/** Who keeps compatibility: an administrator, or the operator command (the dev seed). */
export type CompatibilityActor = Extract<
  AuditActorRecord,
  { role: "admin" } | { role: "operator" }
>;

function reviewer(actor: CompatibilityActor) {
  return actor.role === "admin"
    ? { reviewedByAdminId: actor.adminId, createdByAccountId: actor.accountId }
    : { reviewedByAdminId: null, createdByAccountId: null };
}

/**
 * Approved compatibility records kept by the administrator (TASK-015
 * requirement 2; ARCHITECTURE 4.25; SCREENS A-CAT-05): add, change,
 * archive, and copy from an analog in one action. Every change takes the
 * item's lock, is one transaction with its entry in the action journal,
 * and a stale `expectedVersion` changes nothing (409).
 */
@Injectable()
export class CompatibilityRecordsService {
  private readonly logger = new Logger("Compatibility");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditLog) private readonly audit: AuditLog,
  ) {}

  /** The compatibility card of an item: records and the proposals waiting for review. */
  async card(itemId: string, includeArchived: boolean): Promise<AdminItemCompatibilityResponse> {
    const executor = this.database.db;
    const item = await findItem(executor, itemId);
    const [records, proposals] = await Promise.all([
      executor
        .select()
        .from(itemCompatibility)
        .where(
          and(
            eq(itemCompatibility.itemId, itemId),
            includeArchived ? undefined : eq(itemCompatibility.status, "approved"),
          ),
        )
        .orderBy(asc(itemCompatibility.createdAt), asc(itemCompatibility.id)),
      executor
        .select()
        .from(itemCompatibilityProposal)
        .where(
          and(
            eq(itemCompatibilityProposal.itemId, itemId),
            eq(itemCompatibilityProposal.status, "pending"),
          ),
        )
        .orderBy(asc(itemCompatibilityProposal.createdAt), asc(itemCompatibilityProposal.id)),
    ]);
    return {
      itemId,
      applicable: item.itemType !== "service",
      records: await describeRecords(executor, records),
      proposals: await describeAdminProposals(executor, proposals),
    };
  }

  async create(
    itemId: string,
    input: CreateCompatibilityRecordBody,
    actor: CompatibilityActor,
  ): Promise<AdminCompatibilityRecord> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(VEHICLE_LOCK_SHARED);
      await tx.execute(itemLock(itemId));
      const item = await findItem(tx, itemId);
      assertWritable(item);
      const conditions = await resolveConditions(tx, input.conditions);
      const row = await this.insertApproved(tx, {
        itemId,
        itemType: item.itemType,
        conditions,
        evidence: input.evidence,
        source: "admin",
        copiedFromId: null,
        actor,
      });
      return (await describeRecords(tx, [row]))[0]!;
    });
  }

  async update(
    recordId: string,
    input: UpdateCompatibilityRecordBody,
    actor: CompatibilityActor,
  ): Promise<AdminCompatibilityRecord> {
    const itemId = await this.itemOf(recordId);
    return this.database.db.transaction(async (tx) => {
      await tx.execute(VEHICLE_LOCK_SHARED);
      await tx.execute(itemLock(itemId));
      const row = await this.lockRecord(tx, recordId);
      if (row.version !== input.expectedVersion) {
        throw versionConflict(row.version);
      }
      if (row.status !== "approved") {
        throw notFound("approved compatibility record");
      }
      assertWritable(await findItem(tx, row.itemId));
      const before = conditionsOf(row);
      const conditions = input.conditions ? await resolveConditions(tx, input.conditions) : before;
      const evidence = input.evidence ?? row.evidence;
      const conditionsChanged = !sameConditions(before, conditions);
      if (!conditionsChanged && evidence === row.evidence) {
        return (await describeRecords(tx, [row]))[0]!;
      }
      if (conditionsChanged) {
        const clash = await approvedMatch(tx, row.itemId, conditions, row.id);
        if (clash) {
          throw duplicate(clash.id);
        }
      }
      const [updated] = await tx
        .update(itemCompatibility)
        .set({
          ...conditions,
          evidence,
          ...reviewer(actor),
          reviewedAt: new Date(),
          version: row.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(itemCompatibility.id, row.id))
        .returning();
      await this.audit.record(
        {
          action: auditActions.itemCompatibilityChanged,
          actor,
          entityType: auditEntities.itemCompatibility,
          entityId: row.id,
          before: {
            ...(conditionsChanged ? { conditions: before } : {}),
            ...(evidence !== row.evidence ? { evidence: row.evidence } : {}),
          },
          after: {
            itemId: row.itemId,
            ...(conditionsChanged ? { conditions } : {}),
            ...(evidence !== row.evidence ? { evidence } : {}),
            version: updated!.version,
          },
        },
        tx,
      );
      return (await describeRecords(tx, [updated!]))[0]!;
    });
  }

  async archive(
    recordId: string,
    expectedVersion: number,
    actor: CompatibilityActor,
  ): Promise<AdminCompatibilityRecord> {
    const itemId = await this.itemOf(recordId);
    return this.database.db.transaction(async (tx) => {
      await tx.execute(itemLock(itemId));
      const row = await this.lockRecord(tx, recordId);
      if (row.version !== expectedVersion) {
        throw versionConflict(row.version);
      }
      if (row.status === "archived") {
        return (await describeRecords(tx, [row]))[0]!;
      }
      const now = new Date();
      const [updated] = await tx
        .update(itemCompatibility)
        .set({ status: "archived", archivedAt: now, version: row.version + 1, updatedAt: now })
        .where(eq(itemCompatibility.id, row.id))
        .returning();
      await this.audit.record(
        {
          action: auditActions.itemCompatibilityArchived,
          actor,
          entityType: auditEntities.itemCompatibility,
          entityId: row.id,
          before: { status: "approved" },
          after: { itemId: row.itemId, status: "archived", version: updated!.version },
        },
        tx,
      );
      this.logger.log(`Compatibility record archived record=${row.id}`);
      return (await describeRecords(tx, [updated!]))[0]!;
    });
  }

  /**
   * Copies the approved records of an analog onto the item (TASK-015
   * requirement 2): records the item already has are counted, not
   * repeated. Only an analog (an approved link of TASK-011): copying from
   * any item would spread compatibility to parts nobody compared.
   */
  async copyFromAnalog(
    itemId: string,
    fromItemId: string,
    actor: CompatibilityActor,
  ): Promise<CopyCompatibilityResponse> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(VEHICLE_LOCK_SHARED);
      // Both items in one order: two copies in opposite directions can't deadlock.
      for (const id of [itemId, fromItemId].sort()) {
        await tx.execute(itemLock(id));
      }
      const item = await findItem(tx, itemId);
      assertWritable(item);
      await findItem(tx, fromItemId);
      const [low, high] = [itemId, fromItemId].sort() as [string, string];
      const [link] = await tx
        .select({ status: itemAnalog.status })
        .from(itemAnalog)
        .where(
          or(
            and(eq(itemAnalog.itemId, low), eq(itemAnalog.analogItemId, high)),
            and(eq(itemAnalog.itemId, high), eq(itemAnalog.analogItemId, low)),
          ),
        );
      if (itemId === fromItemId || link?.status !== "approved") {
        throw notAnalog();
      }
      const sources = await tx
        .select()
        .from(itemCompatibility)
        .where(
          and(eq(itemCompatibility.itemId, fromItemId), eq(itemCompatibility.status, "approved")),
        )
        .orderBy(asc(itemCompatibility.createdAt), asc(itemCompatibility.id));
      let created = 0;
      let alreadyPresent = 0;
      for (const source of sources) {
        const conditions = conditionsOf(source);
        if (await approvedMatch(tx, itemId, conditions)) {
          alreadyPresent += 1;
          continue;
        }
        await this.insertApproved(tx, {
          itemId,
          itemType: item.itemType,
          conditions,
          evidence: source.evidence,
          source: "copy",
          copiedFromId: source.id,
          actor,
        });
        created += 1;
      }
      const records = await tx
        .select()
        .from(itemCompatibility)
        .where(and(eq(itemCompatibility.itemId, itemId), eq(itemCompatibility.status, "approved")))
        .orderBy(asc(itemCompatibility.createdAt), asc(itemCompatibility.id));
      this.logger.log(
        `Compatibility copied item=${itemId} from=${fromItemId} created=${String(created)}`,
      );
      return { created, alreadyPresent, records: await describeRecords(tx, records) };
    });
  }

  /**
   * Writes an approved record and its journal entry; the caller holds the
   * item's lock and resolved the conditions. An equal approved record is
   * a 409 with its id.
   */
  async insertApproved(
    tx: DbExecutor,
    input: {
      itemId: string;
      itemType: "part" | "generic";
      conditions: CompatibilityConditions;
      evidence: string;
      source: CompatibilitySource;
      copiedFromId: string | null;
      proposalId?: string;
      actor: CompatibilityActor;
    },
  ): Promise<ItemCompatibilityRow> {
    const clash = await approvedMatch(tx, input.itemId, input.conditions);
    if (clash) {
      throw duplicate(clash.id);
    }
    const [row] = await tx
      .insert(itemCompatibility)
      .values({
        itemId: input.itemId,
        itemType: input.itemType,
        ...input.conditions,
        source: input.source,
        evidence: input.evidence,
        copiedFromId: input.copiedFromId,
        ...reviewer(input.actor),
      })
      .returning();
    await this.audit.record(
      {
        action: auditActions.itemCompatibilityCreated,
        actor: input.actor,
        entityType: auditEntities.itemCompatibility,
        entityId: row!.id,
        after: {
          itemId: input.itemId,
          conditions: input.conditions,
          source: input.source,
          evidence: input.evidence,
          ...(input.copiedFromId ? { copiedFromId: input.copiedFromId } : {}),
          ...(input.proposalId ? { proposalId: input.proposalId } : {}),
        },
      },
      tx,
    );
    this.logger.log(`Compatibility record created record=${row!.id} source=${input.source}`);
    return row!;
  }

  private async itemOf(recordId: string): Promise<string> {
    const [row] = await this.database.db
      .select({ itemId: itemCompatibility.itemId })
      .from(itemCompatibility)
      .where(eq(itemCompatibility.id, recordId));
    if (!row) {
      throw notFound("compatibility record");
    }
    return row.itemId;
  }

  private async lockRecord(tx: DbExecutor, recordId: string): Promise<ItemCompatibilityRow> {
    const [row] = await tx
      .select()
      .from(itemCompatibility)
      .where(eq(itemCompatibility.id, recordId))
      .for("update");
    if (!row) {
      throw notFound("compatibility record");
    }
    return row;
  }
}
