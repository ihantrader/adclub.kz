import { Inject, Injectable, Logger } from "@nestjs/common";
import { auditActions, auditEntities, type SupplierInvitation } from "@adclub/contracts";
import { maskPhone } from "@adclub/domain";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { rateLimitedException } from "../../common/errors";
import { APP_CONFIG, type AppConfig } from "../../config";
import { DatabaseService, type DbExecutor } from "../../database";
import { defineJob, JobQueue, type JobHandler, type JobRunContext } from "../../jobs";
import { AuditLog } from "../audit";
import { account, supplier, supplierMember } from "../identity";
import { AppSettings } from "../settings";
import { supplierInvitation, type SupplierInvitationRow } from "./schema";
import {
  adminIdOf,
  iso,
  notFound,
  type SupplierAdminActor,
  type SupplierSelfActor,
} from "./supplier-common";

/**
 * Sends one invitation (SCREENS W-08) through the message channel.
 * Idempotent: an invitation already sent is not sent again.
 */
export const sendInvitationJob = defineJob({
  name: "suppliers.send-invitation",
  payload: z.object({ invitationId: z.uuid() }),
  timeoutSeconds: 60,
  retry: { limit: 3, delaySeconds: 30, backoff: true },
  singleton: false,
});

export const supplierJobCatalog = [sendInvitationJob];

/** A message to a supplier's employee. */
export interface SupplierMessage {
  /** E.164. */
  phone: string;
  text: string;
}

/**
 * A channel could not deliver. `reason` is a short token safe to log — it
 * never holds the phone number or the text.
 */
export class SupplierMessageDeliveryError extends Error {
  constructor(readonly reason: string) {
    super(`Supplier message delivery failed: ${reason}`);
    this.name = "SupplierMessageDeliveryError";
  }
}

/**
 * Delivery of messages to suppliers' employees (ARCHITECTURE 9.1).
 * **Replacement point**: TASK-026 puts the WhatsApp template (and the SMS
 * fallback) behind this interface; the invitation logic doesn't change.
 */
export abstract class SupplierMessages {
  abstract send(message: SupplierMessage): Promise<{ channel: "test" | "whatsapp" | "sms" }>;
}

/**
 * The stand-in of development and tests (refused in production, like the
 * test login code channels): nothing leaves the process. What was "sent"
 * is kept on the invitation row, and development shows it at
 * `GET /dev/supplier-invitations`, whatever process sent it.
 */
export class TestSupplierMessages extends SupplierMessages {
  /** Every accepted message of this process, newest last (tests read it). */
  readonly sent: SupplierMessage[] = [];
  /** Tests: make the channel fail. */
  failing = false;

  send(message: SupplierMessage): Promise<{ channel: "test" }> {
    if (this.failing) {
      return Promise.reject(new SupplierMessageDeliveryError("test_channel_configured_to_fail"));
    }
    this.sent.push(message);
    return Promise.resolve({ channel: "test" });
  }
}

/** The text of W-08: «{Имя}, вас добавили в кабинет поставщика {компания}. Войти: {ссылка}». */
export function invitationText(input: {
  memberName: string;
  companyName: string;
  link: string | null;
}): string {
  const enter = input.link ? ` Войти: ${input.link}` : "";
  return `${input.memberName}, вас добавили в кабинет поставщика «${input.companyName}».${enter}`;
}

/** The link of an invitation: the cabinet's address (the first configured origin). */
export function cabinetLink(config: AppConfig): string | null {
  return config.http.webOrigins.supplierWeb[0] ?? null;
}

export function describeInvitation(row: SupplierInvitationRow): SupplierInvitation {
  return {
    id: row.id,
    memberId: row.memberId,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    sentAt: iso(row.sentAt),
  };
}

/** What an invitation needs to be written: the employee, the company, the number. */
interface InvitationTarget {
  memberName: string;
  companyName: string;
  phone: string;
}

async function targetOf(
  executor: DbExecutor,
  memberId: string,
): Promise<InvitationTarget | undefined> {
  const [row] = await executor
    .select({
      memberName: supplierMember.displayName,
      companyName: supplier.name,
      phone: account.phone,
    })
    .from(supplierMember)
    .innerJoin(supplier, eq(supplier.id, supplierMember.supplierId))
    .innerJoin(account, eq(account.id, supplierMember.accountId))
    .where(eq(supplierMember.id, memberId));
  return row;
}

/**
 * Invitations of employees (TASK-016 requirement 4): put on the queue in
 * the transaction that creates the employee (or asked again by an
 * administrator, limited in frequency — `supplier_invitation_resend_interval_minutes`
 * since the previous one and `supplier_invitations_per_member_day`), sent
 * by the worker.
 */
@Injectable()
export class SupplierInvitations {
  private readonly logger = new Logger("SupplierInvitation");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(JobQueue) private readonly queue: JobQueue,
    @Inject(AuditLog) private readonly audit: AuditLog,
    @Inject(AppSettings) private readonly settings: AppSettings,
  ) {}

  /** Writes the invitation and puts its sending on the queue — in the caller's transaction. */
  async enqueue(
    tx: DbExecutor,
    input: {
      supplierId: string;
      memberId: string;
      actor: SupplierAdminActor | SupplierSelfActor;
      again: boolean;
    },
  ): Promise<SupplierInvitationRow> {
    const [row] = await tx
      .insert(supplierInvitation)
      .values({
        supplierId: input.supplierId,
        memberId: input.memberId,
        requestedByAdminId: adminIdOf(input.actor),
      })
      .returning();
    await this.queue.enqueue(sendInvitationJob, { invitationId: row!.id }, { tx });
    await this.audit.record(
      {
        action: auditActions.supplierInvitationRequested,
        actor: input.actor,
        entityType: auditEntities.supplierInvitation,
        entityId: row!.id,
        after: { supplierId: input.supplierId, memberId: input.memberId, again: input.again },
      },
      tx,
    );
    return row!;
  }

  /** «Отправить приглашение повторно» (A-SUP-03), limited in frequency. */
  async resend(
    supplierId: string,
    memberId: string,
    actor: SupplierAdminActor,
  ): Promise<SupplierInvitation> {
    const [intervalMinutes, perDay] = await Promise.all([
      this.settings.get("supplier_invitation_resend_interval_minutes"),
      this.settings.get("supplier_invitations_per_member_day"),
    ]);
    const row = await this.database.db.transaction(async (tx) => {
      // The employee's row serializes two resends at once.
      const [member] = await tx
        .select({ id: supplierMember.id })
        .from(supplierMember)
        .where(
          and(
            eq(supplierMember.id, memberId),
            eq(supplierMember.supplierId, supplierId),
            eq(supplierMember.status, "active"),
          ),
        )
        .for("update");
      if (!member) {
        throw notFound("employee");
      }
      const now = Date.now();
      const [latest] = await tx
        .select({ createdAt: supplierInvitation.createdAt })
        .from(supplierInvitation)
        .where(eq(supplierInvitation.memberId, memberId))
        .orderBy(desc(supplierInvitation.createdAt))
        .limit(1);
      const interval = intervalMinutes * 60_000;
      if (latest && now - latest.createdAt.getTime() < interval) {
        this.logger.warn(`Invitation resend refused: too soon member=${memberId}`);
        throw rateLimitedException(
          "supplier_invitation_resend",
          (latest.createdAt.getTime() + interval - now) / 1000,
        );
      }
      const dayAgo = new Date(now - 24 * 3600_000);
      const recent = await tx
        .select({ createdAt: supplierInvitation.createdAt })
        .from(supplierInvitation)
        .where(
          and(eq(supplierInvitation.memberId, memberId), gte(supplierInvitation.createdAt, dayAgo)),
        )
        .orderBy(supplierInvitation.createdAt);
      if (recent.length >= perDay) {
        this.logger.warn(`Invitation resend refused: daily limit member=${memberId}`);
        // The oldest of the day leaves the window first.
        throw rateLimitedException(
          "supplier_invitation_resend",
          (recent[0]!.createdAt.getTime() + 24 * 3600_000 - now) / 1000,
        );
      }
      return this.enqueue(tx, { supplierId, memberId, actor, again: true });
    });
    this.logger.log(`Invitation queued again invitation=${row.id} member=${memberId}`);
    return describeInvitation(row);
  }

  /**
   * The removal of an employee cancels their invitations not yet sent, in
   * the removal's transaction (TASK-017): a restored employee gets a new
   * one, never an old one from before the removal.
   */
  async cancelQueued(tx: DbExecutor, memberId: string, now: Date): Promise<number> {
    const rows = await tx
      .update(supplierInvitation)
      .set({ status: "cancelled", updatedAt: now })
      .where(
        and(eq(supplierInvitation.memberId, memberId), eq(supplierInvitation.status, "queued")),
      )
      .returning({ id: supplierInvitation.id });
    return rows.length;
  }

  /** The latest invitation of each employee. */
  async latestOf(
    executor: DbExecutor,
    memberIds: readonly string[],
  ): Promise<Map<string, SupplierInvitationRow>> {
    if (memberIds.length === 0) {
      return new Map();
    }
    const rows = await executor.execute<{ id: string }>(sql`
      SELECT DISTINCT ON (member_id) id FROM supplier_invitation
      WHERE member_id = ANY(${`{${memberIds.join(",")}}`}::uuid[])
      ORDER BY member_id, created_at DESC
    `);
    if (rows.rows.length === 0) {
      return new Map();
    }
    const full = await executor
      .select()
      .from(supplierInvitation)
      .where(
        sql`${supplierInvitation.id} = ANY(${`{${rows.rows.map((row) => row.id).join(",")}}`}::uuid[])`,
      );
    return new Map(full.map((row) => [row.memberId, row]));
  }
}

/** The worker's side: sends a queued invitation. */
@Injectable()
export class InvitationSender implements JobHandler<{ invitationId: string }> {
  private readonly logger = new Logger("SupplierInvitation");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(SupplierMessages) private readonly messages: SupplierMessages,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Sends in a transaction that share-locks the employee's row for the
   * send (TASK-017): a removal (which updates that row and cancels the
   * queued invitations in its own transaction) either commits first — the
   * invitation is `cancelled` or the employee `removed`, nothing is sent —
   * or waits until the message is out. The lock order, employee then
   * invitation, is the removal's too.
   */
  async run({ invitationId }: { invitationId: string }, context: JobRunContext): Promise<void> {
    const db = this.database.db;
    const [peek] = await db
      .select({ memberId: supplierInvitation.memberId })
      .from(supplierInvitation)
      .where(eq(supplierInvitation.id, invitationId));
    if (!peek) {
      return;
    }
    let failure: string | undefined;
    await db.transaction(async (tx) => {
      const [member] = await tx
        .select({ status: supplierMember.status })
        .from(supplierMember)
        .where(eq(supplierMember.id, peek.memberId))
        .for("share");
      const [row] = await tx
        .select()
        .from(supplierInvitation)
        .where(eq(supplierInvitation.id, invitationId))
        .for("update");
      if (!row || row.status !== "queued") {
        return;
      }
      if (member?.status !== "active") {
        await tx
          .update(supplierInvitation)
          .set({ status: "cancelled", updatedAt: new Date() })
          .where(eq(supplierInvitation.id, row.id));
        this.logger.log(
          `Invitation cancelled: the employee is removed invitation=${row.id} member=${row.memberId}`,
        );
        return;
      }
      const target = await targetOf(tx, row.memberId);
      if (!target) {
        return;
      }
      const text = invitationText({ ...target, link: cabinetLink(this.config) });
      try {
        const { channel } = await this.messages.send({ phone: target.phone, text });
        await tx
          .update(supplierInvitation)
          .set({
            status: "sent",
            channel,
            sentAt: new Date(),
            attempts: sql`${supplierInvitation.attempts} + 1`,
            lastError: null,
            updatedAt: new Date(),
          })
          .where(eq(supplierInvitation.id, row.id));
        this.logger.log(
          `Invitation sent invitation=${row.id} member=${row.memberId} channel=${channel} phone=${maskPhone(target.phone)}`,
        );
      } catch (error) {
        failure = error instanceof SupplierMessageDeliveryError ? error.reason : "unexpected_error";
      }
    });
    if (failure !== undefined) {
      await this.recordFailure(invitationId, failure, context);
    }
  }

  private async recordFailure(
    invitationId: string,
    reason: string,
    context: JobRunContext,
  ): Promise<never> {
    const db = this.database.db;
    const [row] = await db
      .select()
      .from(supplierInvitation)
      .where(eq(supplierInvitation.id, invitationId));
    if (row) {
      // The last run of the job: the invitation failed for good (unless
      // a removal cancelled it meanwhile).
      const final = context.attempt > sendInvitationJob.retry.limit;
      await db
        .update(supplierInvitation)
        .set({
          status: final ? "failed" : row.status,
          attempts: sql`${supplierInvitation.attempts} + 1`,
          lastError: reason,
          updatedAt: new Date(),
        })
        .where(and(eq(supplierInvitation.id, row.id), eq(supplierInvitation.status, "queued")));
      this.logger.warn(
        `Invitation not delivered invitation=${row.id} member=${row.memberId} reason=${reason} attempt=${context.attempt}`,
      );
    }
    throw new SupplierMessageDeliveryError(reason);
  }
}

/**
 * Development only: the latest invitations the test channel "sent", with
 * their text, read from the database (the worker sends them, the API
 * shows them).
 */
@Injectable()
export class DevInvitationOutbox {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async latest(): Promise<
    { sentAt: string | null; status: string; channel: string | null; phone: string; text: string }[]
  > {
    const rows = await this.database.db
      .select()
      .from(supplierInvitation)
      .orderBy(desc(supplierInvitation.createdAt))
      .limit(20);
    const result = [];
    for (const row of rows) {
      const target = await targetOf(this.database.db, row.memberId);
      if (target) {
        result.push({
          sentAt: iso(row.sentAt),
          status: row.status,
          channel: row.channel,
          phone: target.phone,
          text: invitationText({ ...target, link: cabinetLink(this.config) }),
        });
      }
    }
    return result;
  }
}
