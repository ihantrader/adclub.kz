import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { auditActions, auditEntities, type SupplierInvitation } from "@adclub/contracts";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { rateLimitedException } from "../../common/errors";
import { APP_CONFIG, type AppConfig } from "../../config";
import { DatabaseService, type DbExecutor } from "../../database";
import { defineJob, JobQueue, type JobHandler } from "../../jobs";
import { AuditLog } from "../audit";
import { account, supplier, supplierMember } from "../identity";
import { Messaging, MessageSubjects, type MessageOutcome, type MessageSubject } from "../messaging";
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
 * Inviting an employee to the cabinet (W-08) — the first real user of the
 * message gateway (TASK-024 requirement 5). What this module owns is the
 * invitation: who asked for it, how often it may be asked again, and that
 * it is cancelled when the employee is removed. **How a message leaves the
 * platform is not its business any more**: it hands the gateway a template
 * key, the employee's language and the values, and the gateway does the
 * queue, the provider, the retries and the delivery (`Messaging`).
 *
 * What replaced `SupplierMessages` of TASK-016: nothing here knows what a
 * channel is. The one thing that stayed is the job — it is the step that
 * reads the employee, decides the language and asks for the message; the
 * sending itself is the gateway's own job, and so the provider is no longer
 * called while this module holds a row (the complaint of TASK-017).
 */

/** Writes the message of one invitation and hands it to the gateway. */
export const sendInvitationJob = defineJob({
  name: "suppliers.send-invitation",
  payload: z.object({ invitationId: z.uuid() }),
  timeoutSeconds: 60,
  retry: { limit: 3, delaySeconds: 30, backoff: true },
  singleton: false,
});

export const supplierJobCatalog = [sendInvitationJob];

/** What a message about an invitation is about (`MessageSubjects`). */
export const INVITATION_SUBJECT = "supplier_invitation";

export function describeInvitation(row: SupplierInvitationRow): SupplierInvitation {
  return {
    id: row.id,
    memberId: row.memberId,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    sentAt: iso(row.sentAt),
  };
}

/** The link of an invitation: the cabinet's address (the first configured origin). */
export function cabinetLink(config: AppConfig): string | null {
  return config.http.webOrigins.supplierWeb[0] ?? null;
}

/** What the invitation message needs: the employee, the company, the number, the language. */
interface InvitationTarget {
  memberName: string;
  companyName: string;
  phone: string;
  lang: "kk" | "ru";
  memberStatus: string;
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
      lang: supplierMember.notificationLanguage,
      memberStatus: supplierMember.status,
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

/**
 * The worker's side: turns a queued invitation into a message of the
 * gateway. No provider is called here and no row is held while one is: the
 * gateway's own job does the sending, and this transaction only reads the
 * employee and writes the message (TASK-024 requirement 3).
 */
@Injectable()
export class InvitationSender implements JobHandler<{ invitationId: string }> {
  private readonly logger = new Logger("SupplierInvitation");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(Messaging) private readonly messaging: Messaging,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async run({ invitationId }: { invitationId: string }): Promise<void> {
    const link = cabinetLink(this.config);
    await this.database.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(supplierInvitation)
        .where(eq(supplierInvitation.id, invitationId))
        .for("update");
      if (!row || row.status !== "queued") {
        return;
      }
      const target = await targetOf(tx, row.memberId);
      if (!target) {
        return;
      }
      if (target.memberStatus !== "active") {
        await tx
          .update(supplierInvitation)
          .set({ status: "cancelled", updatedAt: new Date() })
          .where(eq(supplierInvitation.id, row.id));
        this.logger.log(
          `Invitation cancelled: the employee is removed invitation=${row.id} member=${row.memberId}`,
        );
        return;
      }
      if (!link) {
        // An invitation without the cabinet's address is of no use to
        // anybody; better a failure the operator sees than a message that
        // tells a person nothing (`SUPPLIER_WEB_ORIGINS`).
        await tx
          .update(supplierInvitation)
          .set({
            status: "failed",
            attempts: sql`${supplierInvitation.attempts} + 1`,
            lastError: "cabinet_link_not_configured",
            updatedAt: new Date(),
          })
          .where(eq(supplierInvitation.id, row.id));
        this.logger.warn(
          `Invitation not sent invitation=${row.id}: no cabinet address is configured (SUPPLIER_WEB_ORIGINS)`,
        );
        return;
      }
      // The message, in the employee's own language (PRODUCT 12.6).
      await this.messaging.enqueue(tx, {
        template: "supplier_invitation",
        phone: target.phone,
        lang: target.lang,
        variables: {
          memberName: target.memberName,
          companyName: target.companyName,
          link,
        },
        subject: { type: INVITATION_SUBJECT, id: row.id },
        // One invitation, one message: asking again writes a new invitation
        // row, and so a new message.
        dedupeKey: `${INVITATION_SUBJECT}:${row.id}`,
      });
    });
  }
}

/**
 * What messaging asks this module about an invitation (`MessageSubjects`):
 * whether it may still go out, and what to keep when it is settled. Both
 * run inside messaging's own short transactions, so the invitation and the
 * message can never disagree — and the provider is called between them,
 * with nothing locked.
 */
@Injectable()
export class SupplierInvitationMessages implements MessageSubject, OnModuleInit {
  private readonly logger = new Logger("SupplierInvitation");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(@Inject(MessageSubjects) private readonly subjects: MessageSubjects) {}

  onModuleInit(): void {
    this.subjects.register(INVITATION_SUBJECT, this);
  }

  /**
   * An invitation goes out only while it is still asked for and the
   * employee is still there. "Still asked for" is `queued` — and `failed`:
   * an invitation that failed is one the operator may bring back
   * (`messages:retry`, `jobs:retry`), and the invitation follows its message
   * rather than cancelling it. Only `cancelled` and `sent` end it. Removing an
   * employee cancels the invitations that are still `queued`, in its own
   * transaction, and this share lock on the employee is what makes the two
   * orders agree — the removal either commits first (and nothing is sent) or
   * waits for this short transaction, which holds no provider call. A `failed`
   * invitation is not touched by the removal: it is decided when it is brought
   * back — the employee is removed by then and it is cancelled, or was
   * restored and it goes out.
   */
  async stillSend(tx: DbExecutor, subjectId: string | null): Promise<boolean> {
    if (!subjectId) {
      return false;
    }
    const [row] = await tx
      .select({ status: supplierInvitation.status, memberId: supplierInvitation.memberId })
      .from(supplierInvitation)
      .where(eq(supplierInvitation.id, subjectId));
    if (!row || (row.status !== "queued" && row.status !== "failed")) {
      return false;
    }
    const [member] = await tx
      .select({ status: supplierMember.status })
      .from(supplierMember)
      .where(eq(supplierMember.id, row.memberId))
      .for("share");
    return member?.status === "active";
  }

  async onResult(tx: DbExecutor, subjectId: string | null, outcome: MessageOutcome): Promise<void> {
    if (!subjectId) {
      return;
    }
    const now = new Date();
    // What is still open: `queued`, and `failed` while its message is brought
    // back. A sent or cancelled invitation is never changed by a late outcome.
    const open = and(
      eq(supplierInvitation.id, subjectId),
      inArray(supplierInvitation.status, ["queued", "failed"]),
    );
    switch (outcome.kind) {
      case "sent":
        await tx
          .update(supplierInvitation)
          .set({
            status: "sent",
            channel: outcome.channel,
            sentAt: now,
            attempts: sql`${supplierInvitation.attempts} + 1`,
            lastError: null,
            updatedAt: now,
          })
          .where(open);
        this.logger.log(`Invitation sent invitation=${subjectId} channel=${outcome.channel}`);
        return;
      case "retrying":
        // A failed attempt that will be tried again: what the invitation always
        // showed while it waited — the attempts so far and why the last failed.
        await tx
          .update(supplierInvitation)
          .set({
            attempts: sql`${supplierInvitation.attempts} + 1`,
            lastError: outcome.failure,
            updatedAt: now,
          })
          .where(
            and(eq(supplierInvitation.id, subjectId), eq(supplierInvitation.status, "queued")),
          );
        return;
      case "failed":
        await tx
          .update(supplierInvitation)
          .set({
            status: "failed",
            attempts: sql`${supplierInvitation.attempts} + 1`,
            lastError: outcome.failure,
            updatedAt: now,
          })
          .where(open);
        this.logger.warn(
          `Invitation not delivered invitation=${subjectId} reason=${outcome.failure}`,
        );
        return;
      case "cancelled":
        await tx
          .update(supplierInvitation)
          .set({ status: "cancelled", updatedAt: now })
          .where(open);
        return;
      case "unknown":
        // Nobody can say whether it went out: not "sent", and not left looking
        // as if it were still on its way. `failed` says a person has to look,
        // and the operator's retry brings it back the same way as any other.
        await tx
          .update(supplierInvitation)
          .set({
            status: "failed",
            attempts: sql`${supplierInvitation.attempts} + 1`,
            lastError: "outcome_unknown",
            updatedAt: now,
          })
          .where(open);
        this.logger.warn(`Invitation left in an unknown state invitation=${subjectId}`);
        return;
    }
  }
}
