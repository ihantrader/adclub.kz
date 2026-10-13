import { Inject, Injectable } from "@nestjs/common";
import type {
  CatalogLanguage,
  MarkModerationSeenBody,
  SupplierCompatibilityProposalQuery,
  SupplierModerationProposalPage,
  SupplierModerationSummary,
} from "@adclub/contracts";
import { and, count, desc, eq, sql, type SQL } from "drizzle-orm";
import { DatabaseService } from "../../database";
import { CatalogPhotosService } from "../catalog";
import { describeSupplierProposals, itemCompatibilityProposal } from "../compatibility";
import { supplierMember } from "../identity";
import { describeOfferItems } from "../offers";
import { moderationSeenAt } from "./moderation-seen";
import { validationError } from "./price-import-errors";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The employee of a cabinet session. */
export interface ModerationActor {
  supplierId: string;
  memberId: string;
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify([createdAt.toISOString(), id]), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      Array.isArray(value) &&
      typeof value[0] === "string" &&
      typeof value[1] === "string" &&
      UUID.test(value[1]) &&
      new Date(value[0]).toISOString() === value[0]
    ) {
      return { createdAt: value[0], id: value[1] };
    }
  } catch {
    // Falls through to the refusal.
  }
  throw validationError("cursor", "Use the nextCursor of the previous page");
}

/**
 * «Модерация» of the cabinet (S-MOD-01, TASK-048; ARCHITECTURE 4.68): the
 * company's requests to add an item (`CatalogRequestsService`) and its
 * compatibility proposals, each with «новое» for the employee who looks.
 *
 * «Просмотрено» is kept on the server for each employee
 * (`supplier_member.moderation_seen_at`): a decision made after the moment
 * the employee last opened the section is «новое» for them and counts in
 * the menu; opening the section sends back the server's time of the answer
 * it showed, and that moment becomes the new one. A colleague's look
 * doesn't take «новое» away from another employee.
 */
@Injectable()
export class ModerationService {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(CatalogPhotosService) private readonly photos: CatalogPhotosService,
  ) {}

  async summary(actor: ModerationActor): Promise<SupplierModerationSummary> {
    // One statement: the moment and the counts by the same database values.
    const result = await this.database.db.execute<{
      requests: number;
      compatibility: number;
      seen_at: string;
      now: string;
    }>(sql`
      WITH seen AS (
        SELECT coalesce(moderation_seen_at, created_at) AS at FROM supplier_member
        WHERE id = ${actor.memberId}
      )
      SELECT
        (SELECT count(*)::int FROM catalog_request r, seen
          WHERE r.supplier_id = ${actor.supplierId} AND r.status <> 'new' AND r.decided_at > seen.at) AS requests,
        (SELECT count(*)::int FROM item_compatibility_proposal p, seen
          WHERE p.supplier_id = ${actor.supplierId} AND p.status <> 'pending' AND p.reviewed_at > seen.at) AS compatibility,
        to_char((SELECT at FROM seen) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS seen_at,
        to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`);
    const row = result.rows[0]!;
    return {
      unseen: {
        requests: row.requests,
        compatibility: row.compatibility,
        total: row.requests + row.compatibility,
      },
      seenAt: row.seen_at ?? new Date(0).toISOString(),
      serverTime: row.now,
    };
  }

  /**
   * The decisions shown up to `seenUntil` are seen. The moment only moves
   * forward and never past now: an older page sent late takes nothing back,
   * a clock of the browser ahead of the server marks nothing in advance.
   */
  async markSeen(
    actor: ModerationActor,
    body: MarkModerationSeenBody,
  ): Promise<SupplierModerationSummary> {
    await this.database.db
      .update(supplierMember)
      .set({
        moderationSeenAt: sql`greatest(coalesce(${supplierMember.moderationSeenAt}, ${supplierMember.createdAt}), least(${new Date(body.seenUntil).toISOString()}::timestamptz + interval '1 millisecond', now()))`,
      })
      .where(eq(supplierMember.id, actor.memberId));
    return this.summary(actor);
  }

  /** The company's compatibility proposals with their items, newest first. */
  async proposals(
    actor: ModerationActor,
    query: SupplierCompatibilityProposalQuery,
    lang: CatalogLanguage,
  ): Promise<SupplierModerationProposalPage> {
    const db = this.database.db;
    const after = query.cursor ? decodeCursor(query.cursor) : null;
    const filters: (SQL | undefined)[] = [
      eq(itemCompatibilityProposal.supplierId, actor.supplierId),
      query.status ? eq(itemCompatibilityProposal.status, query.status) : undefined,
      query.itemId ? eq(itemCompatibilityProposal.itemId, query.itemId) : undefined,
    ];
    const [rows, [total], seenAt] = await Promise.all([
      db
        .select()
        .from(itemCompatibilityProposal)
        .where(
          and(
            ...filters,
            after
              ? sql`(${itemCompatibilityProposal.createdAt}, ${itemCompatibilityProposal.id}) < (${after.createdAt}::timestamptz, ${after.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(itemCompatibilityProposal.createdAt), desc(itemCompatibilityProposal.id))
        .limit(query.limit + 1),
      db
        .select({ value: count() })
        .from(itemCompatibilityProposal)
        .where(and(...filters)),
      moderationSeenAt(db, actor.memberId),
    ]);
    const page = rows.slice(0, query.limit);
    const [proposals, items] = await Promise.all([
      describeSupplierProposals(db, page),
      describeOfferItems(
        db,
        this.photos,
        page.map((row) => row.itemId),
        lang,
      ),
    ]);
    const last = page.at(-1);
    return {
      entries: page.map((row, index) => ({
        proposal: proposals[index]!,
        item: items.get(row.itemId) ?? null,
        isNew: row.status !== "pending" && row.reviewedAt !== null && row.reviewedAt > seenAt,
      })),
      total: total?.value ?? 0,
      nextCursor: rows.length > query.limit && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }
}
