import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  AUDIT_LOG_MAX_PAGE_SIZE,
  type AuditActorRole,
  type AuditLogEntry,
  type AuditLogPage,
  type AuditLogQuery,
} from "@adclub/contracts";
import { ApiException } from "../../common/errors";
import { getRequestId, getRequestOrigin } from "../../common/logging";
import type { DbExecutor } from "../../database";
import { AccountDirectory } from "../identity";
import { AuditLogStore, type AuditLogRow } from "./audit-log.store";

/** Who acted, as the journal records it. */
export type AuditActorRecord =
  | { role: "admin"; accountId: string; adminId: string }
  | { role: "supplier"; accountId: string; supplierId: string; memberId: string }
  | { role: "user"; accountId: string }
  /** The server operator command: no account behind it (D-045). */
  | { role: "operator" }
  /** The platform itself, e.g. a scheduled job. */
  | { role: "system" };

export interface AuditEntryInput {
  /** `<entity>.<what happened>`, from `auditActions`. */
  action: string;
  actor: AuditActorRecord;
  entityType: string;
  entityId: string;
  /** The state before and after; left out when the action has none. */
  before?: unknown;
  after?: unknown;
  reason?: string | null;
}

/**
 * Longest `before`/`after` written, in characters of their JSON. A bigger
 * value is replaced by a marker with its size — the journal stays readable
 * and one action can't fill the table (edge case, TASK-009).
 */
export const AUDIT_VALUE_MAX_CHARS = 16_000;

function bounded(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  let text: string;
  try {
    text = JSON.stringify(value) ?? "null";
  } catch {
    return { truncated: true, reason: "not_serializable" };
  }
  if (text.length <= AUDIT_VALUE_MAX_CHARS) {
    return value;
  }
  return { truncated: true, chars: text.length, preview: text.slice(0, 1000) };
}

function cursorOf(row: AuditLogRow): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`, "utf8").toString("base64url");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseCursor(cursor: string): { createdAt: Date; id: string } {
  const [at, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  const createdAt = at ? new Date(at) : new Date(Number.NaN);
  // The id goes into the query as a uuid: anything else is refused here
  // rather than failing the statement.
  if (!id || !UUID.test(id) || Number.isNaN(createdAt.getTime())) {
    throw new ApiException(400, "VALIDATION_ERROR", "The paging cursor is not one we issued", {
      details: [{ path: "cursor", message: "Use the nextCursor of the previous page" }],
    });
  }
  return { createdAt, id };
}

/**
 * The action journal (ARCHITECTURE 4.13, 5.12, 15.3): writing an entry in
 * the transaction of the action it records, and reading the journal for the
 * admin panel. Significant actions only — a session issued at an ordinary
 * sign-in stays in the application log.
 *
 * `record` never invents an actor: the caller states who acted. The
 * caller's address, `User-Agent` and request id come from the request
 * context, so a service deep below the controller records them without
 * being handed the request.
 */
@Injectable()
export class AuditLog {
  private readonly logger = new Logger("Audit");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(AuditLogStore) private readonly store: AuditLogStore,
    @Inject(AccountDirectory) private readonly accounts: AccountDirectory,
  ) {}

  /**
   * Records one action. `executor` is the transaction of the action
   * itself: if it rolls back, the entry goes with it, and a failure to
   * write the entry fails the action — there is no action without an
   * entry (business rule, TASK-009).
   */
  async record(entry: AuditEntryInput, executor: DbExecutor): Promise<string> {
    const origin = getRequestOrigin();
    const { actor } = entry;
    const row = await this.store.append(
      {
        action: entry.action,
        actorRole: actor.role,
        actorAccountId: "accountId" in actor ? actor.accountId : null,
        actorAdminId: actor.role === "admin" ? actor.adminId : null,
        actorSupplierId: actor.role === "supplier" ? actor.supplierId : null,
        actorMemberId: actor.role === "supplier" ? actor.memberId : null,
        entityType: entry.entityType,
        entityId: entry.entityId,
        before: bounded(entry.before),
        after: bounded(entry.after),
        reason: entry.reason ?? null,
        ip: origin.ip,
        userAgent: origin.userAgent,
        requestId: getRequestId() ?? null,
      },
      executor,
    );
    // The entry itself holds the detail; the log line only says it exists.
    this.logger.log(
      `Action recorded action=${entry.action} entity=${entry.entityType}:${entry.entityId} by=${this.actorLabel(actor)} audit=${row.id}`,
    );
    return row.id;
  }

  /** One page of the journal, newest first (admin panel; SCREENS, TASK-034). */
  async page(query: AuditLogQuery): Promise<AuditLogPage> {
    const limit = Math.min(query.limit, AUDIT_LOG_MAX_PAGE_SIZE);
    const rows = await this.store.page({
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      action: query.action,
      entityType: query.entityType,
      entityId: query.entityId,
      actorAccountId: query.actorAccountId,
      actorRole: query.actorRole as AuditActorRole | undefined,
      before: query.cursor ? parseCursor(query.cursor) : undefined,
      // One extra row tells whether another page follows.
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    const phones = await this.accounts.maskedPhones(
      page.flatMap((row) => (row.actorAccountId ? [row.actorAccountId] : [])),
    );
    const last = page.at(-1);
    return {
      entries: page.map((row) => this.toEntry(row, phones)),
      nextCursor: rows.length > limit && last ? cursorOf(last) : null,
    };
  }

  private toEntry(row: AuditLogRow, phones: Map<string, string>): AuditLogEntry {
    return {
      id: row.id,
      action: row.action,
      actor: {
        role: row.actorRole,
        accountId: row.actorAccountId,
        phoneMasked: (row.actorAccountId && phones.get(row.actorAccountId)) ?? null,
        adminId: row.actorAdminId,
        supplierId: row.actorSupplierId,
        supplierMemberId: row.actorMemberId,
      },
      entityType: row.entityType,
      entityId: row.entityId,
      before: row.before ?? null,
      after: row.after ?? null,
      reason: row.reason,
      ip: row.ip,
      userAgent: row.userAgent,
      requestId: row.requestId,
      at: row.createdAt.toISOString(),
    };
  }

  private actorLabel(actor: AuditActorRecord): string {
    switch (actor.role) {
      case "admin":
        return `admin:${actor.adminId}`;
      case "supplier":
        return `member:${actor.memberId}`;
      case "user":
        return `account:${actor.accountId}`;
      default:
        return actor.role;
    }
  }
}
