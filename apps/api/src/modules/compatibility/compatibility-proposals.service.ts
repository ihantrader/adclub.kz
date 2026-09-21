import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  auditActions,
  auditEntities,
  type AdminCompatibilityProposalPage,
  type AdminCompatibilityProposalQuery,
  type AdminCompatibilityProposalResponse,
  type ApproveCompatibilityProposalBody,
  type CreateCompatibilityProposalBody,
  type SupplierCompatibilityProposal,
  type SupplierCompatibilityProposalPage,
  type SupplierCompatibilityProposalQuery,
} from "@adclub/contracts";
import { and, asc, count, desc, eq, sql, type SQL } from "drizzle-orm";
import { rateLimitedException } from "../../common/errors";
import { DatabaseService, type DbExecutor } from "../../database";
import { AuditLog, type AuditActorRecord } from "../audit";
import { decodeCursor, encodeCursor, TIME_POSITION } from "../catalog";
import { AppSettings } from "../settings";
import { conditionsOf, resolveConditions, sameConditions } from "./compatibility-conditions";
import {
  notApplicable,
  notFound,
  proposalDuplicate,
  proposalState,
  validationError,
} from "./compatibility-errors";
import {
  CompatibilityRecordsService,
  type CompatibilityActor,
} from "./compatibility-records.service";
import {
  approvedMatch,
  assertWritable,
  describeAdminProposals,
  describeRecords,
  describeSupplierProposals,
  findItem,
  itemLock,
  sameConditionsWhere,
  VEHICLE_LOCK_SHARED,
} from "./compatibility-store";
import { itemCompatibilityProposal, type ItemCompatibilityProposalRow } from "./schema";

export type SupplierActor = Extract<AuditActorRecord, { role: "supplier" }>;
type AdminActor = Extract<CompatibilityActor, { role: "admin" }>;

/** The rolling window of the proposal limit. */
const LIMIT_WINDOW_SECONDS = 24 * 60 * 60;

const createdPosition = sql<string>`to_char(${itemCompatibilityProposal.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

function after(cursor: string | undefined) {
  if (!cursor) {
    return undefined;
  }
  const position = decodeCursor(cursor);
  if (!TIME_POSITION.test(position.position)) {
    throw validationError("cursor", "Use the nextCursor of the previous page");
  }
  return position;
}

/**
 * Proposals of compatibility and their moderation (TASK-015 requirement 3;
 * ARCHITECTURE 4.25; D-004; SCREENS A-MOD). A supplier proposes a record
 * for an active part or product and sees only the company's own
 * proposals; nothing changes for users until an administrator approves a
 * proposal — as it is or corrected — into an approved record, or rejects
 * it with a reason the supplier sees.
 */
@Injectable()
export class CompatibilityProposalsService {
  private readonly logger = new Logger("Compatibility");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditLog) private readonly audit: AuditLog,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(CompatibilityRecordsService) private readonly records: CompatibilityRecordsService,
  ) {}

  // -------------------------------------------------------------- supplier

  async propose(
    itemId: string,
    input: CreateCompatibilityProposalBody,
    actor: SupplierActor,
  ): Promise<SupplierCompatibilityProposal> {
    const limit = await this.settings.get("compatibility_proposals_per_supplier_day");
    return this.database.db.transaction(async (tx) => {
      await tx.execute(VEHICLE_LOCK_SHARED);
      // One company's proposals one at a time: the limit is counted exactly.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('compatibility_proposals'), hashtext(${actor.supplierId}))`,
      );
      const item = await findItem(tx, itemId).catch(() => null);
      // A supplier sees the catalog as clients do: a draft or an archived
      // item is as missing as one that doesn't exist.
      if (!item || item.status !== "active") {
        throw notFound("item");
      }
      if (item.itemType === "service") {
        throw notApplicable();
      }
      await this.assertWithinLimit(tx, actor.supplierId, limit);
      const conditions = await resolveConditions(tx, input.conditions);
      const [pending] = await tx
        .select({ id: itemCompatibilityProposal.id })
        .from(itemCompatibilityProposal)
        .where(
          and(
            eq(itemCompatibilityProposal.supplierId, actor.supplierId),
            eq(itemCompatibilityProposal.itemId, itemId),
            eq(itemCompatibilityProposal.status, "pending"),
            sameConditionsWhere(itemCompatibilityProposal, conditions),
          ),
        );
      if (pending) {
        throw proposalDuplicate();
      }
      const [row] = await tx
        .insert(itemCompatibilityProposal)
        .values({
          itemId,
          itemType: item.itemType,
          ...conditions,
          evidence: input.evidence,
          source: "supplier",
          supplierId: actor.supplierId,
          supplierMemberId: actor.memberId,
          proposedByAccountId: actor.accountId,
        })
        .returning();
      await this.audit.record(
        {
          action: auditActions.compatibilityProposalCreated,
          actor,
          entityType: auditEntities.itemCompatibilityProposal,
          entityId: row!.id,
          after: { itemId, conditions, evidence: input.evidence },
        },
        tx,
      );
      this.logger.log(
        `Compatibility proposal created proposal=${row!.id} supplier=${actor.supplierId}`,
      );
      return (await describeSupplierProposals(tx, [row!]))[0]!;
    });
  }

  async supplierPage(
    supplierId: string,
    query: SupplierCompatibilityProposalQuery,
  ): Promise<SupplierCompatibilityProposalPage> {
    const executor = this.database.db;
    const position = after(query.cursor);
    const filters: (SQL | undefined)[] = [
      eq(itemCompatibilityProposal.supplierId, supplierId),
      query.status ? eq(itemCompatibilityProposal.status, query.status) : undefined,
      query.itemId ? eq(itemCompatibilityProposal.itemId, query.itemId) : undefined,
    ];
    const [rows, [total]] = await Promise.all([
      executor
        .select({ proposal: itemCompatibilityProposal, position: createdPosition })
        .from(itemCompatibilityProposal)
        .where(
          and(
            ...filters,
            position
              ? sql`(${itemCompatibilityProposal.createdAt}, ${itemCompatibilityProposal.id}) < (${position.position}::timestamptz, ${position.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(itemCompatibilityProposal.createdAt), desc(itemCompatibilityProposal.id))
        .limit(query.limit + 1),
      executor
        .select({ value: count() })
        .from(itemCompatibilityProposal)
        .where(and(...filters)),
    ]);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      proposals: await describeSupplierProposals(
        executor,
        page.map((row) => row.proposal),
      ),
      total: total?.value ?? 0,
      nextCursor:
        rows.length > query.limit && last ? encodeCursor(last.position, last.proposal.id) : null,
    };
  }

  /** One proposal of the company; another company's is as missing as one that doesn't exist. */
  async supplierProposal(
    supplierId: string,
    proposalId: string,
  ): Promise<SupplierCompatibilityProposal> {
    const executor = this.database.db;
    const [row] = await executor
      .select()
      .from(itemCompatibilityProposal)
      .where(
        and(
          eq(itemCompatibilityProposal.id, proposalId),
          eq(itemCompatibilityProposal.supplierId, supplierId),
        ),
      );
    if (!row) {
      throw notFound("proposal");
    }
    return (await describeSupplierProposals(executor, [row]))[0]!;
  }

  // ----------------------------------------------------------------- admin

  /** The moderation queue: oldest first, so nothing waits forever. */
  async queue(query: AdminCompatibilityProposalQuery): Promise<AdminCompatibilityProposalPage> {
    const executor = this.database.db;
    const position = after(query.cursor);
    const filters: (SQL | undefined)[] = [
      eq(itemCompatibilityProposal.status, query.status),
      query.itemId ? eq(itemCompatibilityProposal.itemId, query.itemId) : undefined,
      query.supplierId ? eq(itemCompatibilityProposal.supplierId, query.supplierId) : undefined,
    ];
    const [rows, [total]] = await Promise.all([
      executor
        .select({ proposal: itemCompatibilityProposal, position: createdPosition })
        .from(itemCompatibilityProposal)
        .where(
          and(
            ...filters,
            position
              ? sql`(${itemCompatibilityProposal.createdAt}, ${itemCompatibilityProposal.id}) > (${position.position}::timestamptz, ${position.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(asc(itemCompatibilityProposal.createdAt), asc(itemCompatibilityProposal.id))
        .limit(query.limit + 1),
      executor
        .select({ value: count() })
        .from(itemCompatibilityProposal)
        .where(and(...filters)),
    ]);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      proposals: await describeAdminProposals(
        executor,
        page.map((row) => row.proposal),
      ),
      total: total?.value ?? 0,
      nextCursor:
        rows.length > query.limit && last ? encodeCursor(last.position, last.proposal.id) : null,
    };
  }

  /**
   * Approves a proposal (as it is, or with corrected conditions and
   * grounds) into an approved record. When the item already has an
   * approved record with the same conditions — another supplier proposed
   * the same, or the administrator added it — the proposal is linked to it
   * and nothing is duplicated.
   */
  async approve(
    proposalId: string,
    input: ApproveCompatibilityProposalBody,
    actor: AdminActor,
  ): Promise<AdminCompatibilityProposalResponse> {
    const itemId = await this.itemOf(proposalId);
    return this.database.db.transaction(async (tx) => {
      await tx.execute(VEHICLE_LOCK_SHARED);
      await tx.execute(itemLock(itemId));
      const proposal = await this.lockPending(tx, proposalId);
      const item = await findItem(tx, proposal.itemId);
      assertWritable(item);
      const proposed = conditionsOf(proposal);
      const conditions = input.conditions
        ? await resolveConditions(tx, input.conditions)
        : proposed;
      const changed = !sameConditions(proposed, conditions);
      const existing = await approvedMatch(tx, proposal.itemId, conditions);
      const record =
        existing ??
        (await this.records.insertApproved(tx, {
          itemId: proposal.itemId,
          itemType: item.itemType,
          conditions,
          evidence: input.evidence ?? proposal.evidence,
          source: proposal.source,
          copiedFromId: null,
          proposalId: proposal.id,
          actor,
        }));
      const resolution = existing ? "already_approved" : "created";
      const now = new Date();
      const [updated] = await tx
        .update(itemCompatibilityProposal)
        .set({
          status: "approved",
          resolution,
          approvedWithChanges: changed,
          compatibilityId: record.id,
          reviewedByAdminId: actor.adminId,
          reviewedByAccountId: actor.accountId,
          reviewedAt: now,
          updatedAt: now,
        })
        .where(eq(itemCompatibilityProposal.id, proposal.id))
        .returning();
      await this.audit.record(
        {
          action: auditActions.compatibilityProposalApproved,
          actor,
          entityType: auditEntities.itemCompatibilityProposal,
          entityId: proposal.id,
          before: { status: "pending" },
          after: {
            status: "approved",
            itemId: proposal.itemId,
            recordId: record.id,
            resolution,
            ...(changed ? { conditions } : {}),
          },
        },
        tx,
      );
      this.logger.log(`Compatibility proposal approved proposal=${proposal.id} ${resolution}`);
      return {
        proposal: (await describeAdminProposals(tx, [updated!]))[0]!,
        record: (await describeRecords(tx, [record]))[0]!,
      };
    });
  }

  async reject(
    proposalId: string,
    reason: string,
    actor: AdminActor,
  ): Promise<AdminCompatibilityProposalResponse> {
    return this.database.db.transaction(async (tx) => {
      const proposal = await this.lockPending(tx, proposalId);
      const now = new Date();
      const [updated] = await tx
        .update(itemCompatibilityProposal)
        .set({
          status: "rejected",
          rejectionReason: reason,
          reviewedByAdminId: actor.adminId,
          reviewedByAccountId: actor.accountId,
          reviewedAt: now,
          updatedAt: now,
        })
        .where(eq(itemCompatibilityProposal.id, proposal.id))
        .returning();
      await this.audit.record(
        {
          action: auditActions.compatibilityProposalRejected,
          actor,
          entityType: auditEntities.itemCompatibilityProposal,
          entityId: proposal.id,
          before: { status: "pending" },
          after: { status: "rejected", itemId: proposal.itemId },
          reason,
        },
        tx,
      );
      this.logger.log(`Compatibility proposal rejected proposal=${proposal.id}`);
      return { proposal: (await describeAdminProposals(tx, [updated!]))[0]!, record: null };
    });
  }

  // --------------------------------------------------------------- helpers

  private async assertWithinLimit(
    tx: DbExecutor,
    supplierId: string,
    limit: number,
  ): Promise<void> {
    const result = await tx.execute<{ proposals: number; wait: number | null }>(sql`
      SELECT count(*)::int AS proposals,
        extract(epoch FROM min(created_at) + make_interval(secs => ${LIMIT_WINDOW_SECONDS}) - now())::float AS wait
      FROM item_compatibility_proposal
      WHERE supplier_id = ${supplierId}::uuid
        AND created_at > now() - make_interval(secs => ${LIMIT_WINDOW_SECONDS})
    `);
    const row = result.rows[0];
    if (row && Number(row.proposals) >= limit) {
      // The earliest proposal of the window leaves it first.
      throw rateLimitedException(
        "compatibility_proposals_per_supplier",
        Number(row.wait ?? LIMIT_WINDOW_SECONDS),
      );
    }
  }

  private async itemOf(proposalId: string): Promise<string> {
    const [row] = await this.database.db
      .select({ itemId: itemCompatibilityProposal.itemId })
      .from(itemCompatibilityProposal)
      .where(eq(itemCompatibilityProposal.id, proposalId));
    if (!row) {
      throw notFound("proposal");
    }
    return row.itemId;
  }

  private async lockPending(
    tx: DbExecutor,
    proposalId: string,
  ): Promise<ItemCompatibilityProposalRow> {
    const [row] = await tx
      .select()
      .from(itemCompatibilityProposal)
      .where(eq(itemCompatibilityProposal.id, proposalId))
      .for("update");
    if (!row) {
      throw notFound("proposal");
    }
    if (row.status !== "pending") {
      throw proposalState(row.status);
    }
    return row;
  }
}
