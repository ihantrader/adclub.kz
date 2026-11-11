import { Inject, Injectable } from "@nestjs/common";
import {
  auditActions,
  auditEntities,
  type AdminAssistantComplaint,
  type AdminAssistantComplaintListQuery,
  type AdminAssistantComplaintPage,
  type AdminAssistantComplaintResponse,
  type ResolveAssistantComplaintBody,
} from "@adclub/contracts";
import { hidePhone } from "@adclub/domain";
import { asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { ApiException } from "../../common/errors";
import { DatabaseService, type DbExecutor } from "../../database";
import { aiJob } from "../ai";
import { AuditLog } from "../audit";
import { account, adminUser } from "../identity";
import { city, localizedCityName } from "../suppliers";
import {
  assistantComplaint,
  assistantDialog,
  assistantMessage,
  type AssistantComplaintRow,
  type AssistantDialogRow,
} from "./schema";

/** The administrator acting (the access rule set them). */
export interface AssistantAdmin {
  adminId: string;
  accountId: string;
}

/**
 * Complaints about answers of the assistant for the administrator (TASK-062;
 * SCREENS M-AI-01 «Пожаловаться на ответ»): the list (new and resolved), one
 * with the whole dialog — the messages, the tool calls with their arguments
 * and cut results, the cost of each turn by `ai_job` — and «Решить…» with an
 * internal comment and the version seen. The person's number is hidden here
 * as everywhere in the admin panel (TASK-036.B).
 */
@Injectable()
export class AssistantAdminService {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditLog) private readonly audit: AuditLog,
  ) {}

  /** «Жалобы на помощника · N» of the home screen: the very rule of the list's `status=new`. */
  async newCount(): Promise<number> {
    const [row] = await this.database.db
      .select({ total: count() })
      .from(assistantComplaint)
      .where(eq(assistantComplaint.status, "new"));
    return row?.total ?? 0;
  }

  async list(query: AdminAssistantComplaintListQuery): Promise<AdminAssistantComplaintPage> {
    const executor = this.database.db;
    const status = query.status ?? "new";
    const where = status === "all" ? undefined : eq(assistantComplaint.status, status);
    const [rows, [total], counts] = await Promise.all([
      executor
        .select()
        .from(assistantComplaint)
        .where(where)
        .orderBy(desc(assistantComplaint.createdAt), desc(assistantComplaint.id))
        .limit(query.limit)
        .offset(query.offset),
      executor.select({ total: count() }).from(assistantComplaint).where(where),
      executor
        .select({ status: assistantComplaint.status, total: count() })
        .from(assistantComplaint)
        .groupBy(assistantComplaint.status),
    ]);
    const all = total?.total ?? 0;
    return {
      complaints: await this.views(executor, rows),
      total: all,
      counts: {
        new: counts.find((row) => row.status === "new")?.total ?? 0,
        resolved: counts.find((row) => row.status === "resolved")?.total ?? 0,
      },
      nextOffset: query.offset + rows.length < all ? query.offset + rows.length : null,
    };
  }

  async one(complaintId: string): Promise<AdminAssistantComplaintResponse> {
    const executor = this.database.db;
    const [row] = await executor
      .select()
      .from(assistantComplaint)
      .where(eq(assistantComplaint.id, complaintId));
    if (!row) throw new ApiException(404, "NOT_FOUND", "No such complaint");
    const [view] = await this.views(executor, [row]);
    const messages = await executor
      .select()
      .from(assistantMessage)
      .where(eq(assistantMessage.dialogId, row.dialogId))
      .orderBy(asc(assistantMessage.createdAt), desc(assistantMessage.role));
    const jobIds = messages.flatMap((message) => message.aiJobIds);
    const jobs =
      jobIds.length > 0
        ? await executor
            .select({ id: aiJob.id, model: aiJob.model, costUsd: aiJob.costUsd })
            .from(aiJob)
            .where(inArray(aiJob.id, jobIds))
        : [];
    const jobOf = new Map(jobs.map((job) => [job.id, job]));
    return {
      complaint: view!,
      messages: messages.map((message) => {
        const own = message.aiJobIds.flatMap((id) => {
          const job = jobOf.get(id);
          return job ? [job] : [];
        });
        return {
          id: message.id,
          role: message.role,
          createdAt: message.createdAt.toISOString(),
          text: message.text,
          kind: message.kind,
          intent: message.intent,
          itemIds: message.itemIds,
          droppedItems: message.droppedItems,
          toolCalls: message.toolCalls,
          ai: {
            calls: message.aiJobIds.length,
            models: [...new Set(own.map((job) => job.model))],
            costUsd: own.reduce((sum, job) => sum + Number(job.costUsd ?? 0), 0),
          },
        };
      }),
    };
  }

  async resolve(
    complaintId: string,
    body: ResolveAssistantComplaintBody,
    admin: AssistantAdmin,
  ): Promise<AdminAssistantComplaintResponse> {
    await this.database.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(assistantComplaint)
        .where(eq(assistantComplaint.id, complaintId))
        .for("update");
      if (!current) throw new ApiException(404, "NOT_FOUND", "No such complaint");
      if (current.version !== body.expectedVersion || current.status === "resolved") {
        const [view] = await this.views(tx, [current]);
        throw new ApiException(
          409,
          "ASSISTANT_COMPLAINT_CONFLICT",
          "The complaint was resolved by someone else",
          { details: { complaint: view } },
        );
      }
      await tx
        .update(assistantComplaint)
        .set({
          status: "resolved",
          comment: body.comment,
          resolvedBy: admin.adminId,
          resolvedAt: sql`now()`,
          version: sql`${assistantComplaint.version} + 1`,
          updatedAt: sql`now()`,
        })
        .where(eq(assistantComplaint.id, complaintId));
      await this.audit.record(
        {
          action: auditActions.assistantComplaintResolved,
          actor: { role: "admin", accountId: admin.accountId, adminId: admin.adminId },
          entityType: auditEntities.assistantComplaint,
          entityId: complaintId,
          before: { status: current.status },
          after: { status: "resolved", dialogId: current.dialogId },
          reason: body.comment,
        },
        tx,
      );
    });
    return this.one(complaintId);
  }

  private async views(
    executor: DbExecutor,
    rows: readonly AssistantComplaintRow[],
  ): Promise<AdminAssistantComplaint[]> {
    if (rows.length === 0) return [];
    const dialogIds = [...new Set(rows.map((row) => row.dialogId))];
    const messageIds = rows.map((row) => row.messageId);
    const [dialogs, messages] = await Promise.all([
      executor.select().from(assistantDialog).where(inArray(assistantDialog.id, dialogIds)),
      executor.select().from(assistantMessage).where(inArray(assistantMessage.id, messageIds)),
    ]);
    const dialogOf = new Map(dialogs.map((row) => [row.id, row]));
    const messageOf = new Map(messages.map((row) => [row.id, row]));
    const accountIds = [
      ...new Set(dialogs.flatMap((row) => (row.accountId ? [row.accountId] : []))),
    ];
    const adminIds = [...new Set(rows.flatMap((row) => (row.resolvedBy ? [row.resolvedBy] : [])))];
    const cityIds = [...new Set(dialogs.flatMap((row) => (row.cityId ? [row.cityId] : [])))];
    const [accounts, admins, cities, costs] = await Promise.all([
      accountIds.length > 0
        ? executor
            .select({ id: account.id, name: account.name, phone: account.phone })
            .from(account)
            .where(inArray(account.id, accountIds))
        : [],
      adminIds.length > 0
        ? executor
            .select({ id: adminUser.id, name: account.name })
            .from(adminUser)
            .innerJoin(account, eq(account.id, adminUser.accountId))
            .where(inArray(adminUser.id, adminIds))
        : [],
      cityIds.length > 0 ? executor.select().from(city).where(inArray(city.id, cityIds)) : [],
      this.costs(executor, dialogIds),
    ]);
    const accountOf = new Map(accounts.map((row) => [row.id, row]));
    const adminOf = new Map(admins.map((row) => [row.id, row.name]));
    const cityOf = new Map(cities.map((row) => [row.id, localizedCityName(row, "ru").text]));
    return rows.map((row) => {
      const dialog = dialogOf.get(row.dialogId)!;
      const message = messageOf.get(row.messageId);
      const person = dialog.accountId ? accountOf.get(dialog.accountId) : undefined;
      return {
        id: row.id,
        version: row.version,
        status: row.status,
        reason: row.reason,
        text: row.text,
        comment: row.comment,
        message: {
          id: row.messageId,
          kind: message?.kind ?? "answer",
          intent: message?.intent ?? null,
          text: message?.text ?? null,
          itemIds: message?.itemIds ?? [],
        },
        dialog: summaryOf(dialog, person, cityOf, costs.get(dialog.id) ?? 0),
        resolvedBy: row.resolvedBy
          ? { adminId: row.resolvedBy, name: adminOf.get(row.resolvedBy) ?? null }
          : null,
        resolvedAt: row.resolvedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      };
    });
  }

  /** What each dialog's AI calls cost, USD (`ai_job`). */
  private async costs(
    executor: DbExecutor,
    dialogIds: readonly string[],
  ): Promise<Map<string, number>> {
    const result = await executor.execute<{ id: string; cost: string; turns: string }>(sql`
      SELECT m.dialog_id::text AS id, COALESCE(sum(j.cost_usd), 0)::text AS cost
      FROM ${assistantMessage} m
      JOIN ${aiJob} j ON j.id = ANY (m.ai_job_ids)
      WHERE m.dialog_id IN (${sql.join(
        dialogIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
      GROUP BY m.dialog_id`);
    return new Map(result.rows.map((row) => [row.id, Number(row.cost)]));
  }
}

function summaryOf(
  dialog: AssistantDialogRow,
  person: { id: string; name: string | null; phone: string } | undefined,
  cityOf: Map<string, string>,
  costUsd: number,
): AdminAssistantComplaint["dialog"] {
  return {
    id: dialog.id,
    scope: dialog.accountId ? "account" : "guest",
    user: person
      ? { accountId: person.id, name: person.name, phone: hidePhone(person.phone) }
      : null,
    car: dialog.carWords,
    city: dialog.cityId ? (cityOf.get(dialog.cityId) ?? null) : null,
    language: dialog.language,
    turns: dialog.turns,
    costUsd: Math.round(costUsd * 1_000_000) / 1_000_000,
    createdAt: dialog.createdAt.toISOString(),
  };
}
