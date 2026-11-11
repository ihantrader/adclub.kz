import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  ASSISTANT_SUBJECT_ID,
  auditActions,
  auditEntities,
  type AssistantComplaintBody,
  type AssistantComplaintResponse,
  type AssistantDialogResponse,
  type AssistantLimits,
  type AssistantMessageBody,
  type AssistantMessageResponse,
  type AssistantReply,
  type CatalogLanguage,
} from "@adclub/contracts";
import { normalizeAssistantMessage } from "@adclub/domain";
import { and, asc, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { ApiException } from "../../common/errors";
import { DatabaseService } from "../../database";
import { Metrics } from "../../observability";
import { aiJob, AiService, type AiInitiator } from "../ai";
import { AuditLog } from "../audit";
import type { AuthenticatedSession } from "../identity";
import { ShowcaseService } from "../showcase";
import { AppSettings } from "../settings";
import { AdminSignals } from "../signals";
import { carWordsOf, dialogCarOf, type DialogCar } from "./assistant-car";
import { AssistantLimitsService, type Asker, type Charge } from "./assistant-limits";
import { AssistantPipeline, type TurnOutcome } from "./assistant-pipeline";
import { UNAVAILABLE_TEXT } from "./assistant-texts";
import type { StoredReply } from "./assistant-types";
import {
  assistantComplaint,
  assistantDialog,
  assistantMessage,
  type AssistantDialogRow,
  type AssistantMessageRow,
} from "./schema";
import { resolveVehicle } from "../compatibility";

/**
 * A turn whose claim is older than the longest turn (`assistant_turn_seconds`)
 * and this margin is taken to have died with its process.
 */
const TURN_CLAIM_MARGIN_SECONDS = 120;

/** The start of the Almaty day (ARCHITECTURE 13.3). */
const ALMATY_DAY_START = sql`(date_trunc('day', now() AT TIME ZONE 'Asia/Almaty') AT TIME ZONE 'Asia/Almaty')`;

function notFound(): ApiException {
  return new ApiException(404, "NOT_FOUND", "No such dialog");
}

/** The answer of a stored message as it was shown. */
export function replyOf(row: AssistantMessageRow): AssistantReply {
  const reply = row.reply;
  return {
    id: row.id,
    role: "assistant",
    createdAt: row.createdAt.toISOString(),
    kind: row.kind ?? "answer",
    intent: row.intent,
    text: row.text ?? "",
    question: reply?.question ? { text: row.text ?? "", options: reply.question.options } : null,
    cards: reply?.cards ?? [],
    groups: reply?.groups ?? [],
    total: reply?.total ?? null,
    orderEachItem: reply?.orderEachItem ?? false,
    notOnPlatform: reply?.notOnPlatform ?? [],
    disclaimer: reply?.disclaimer ?? null,
    mileageSuggestion: reply?.mileageSuggestion ?? null,
    notFound: reply?.notFound ?? false,
    unavailable: reply?.unavailable ?? null,
  };
}

/**
 * The assistant for the person (TASK-062; PRODUCT 8.3; ARCHITECTURE 4.85;
 * SCREENS M-AI-01, M-AI-02): a turn of a dialog, the current dialog, what is
 * left, a complaint about an answer.
 *
 * A turn: the message is normalised (empty — 400); the dialog is the one
 * named (only one's own — another's is 404, as a missing one) or a new one
 * for the car (D-062) and the city; one turn of a dialog at a time
 * (`ASSISTANT_TURN_IN_PROGRESS`), at most `assistant_max_turns`
 * (`ASSISTANT_DIALOG_FULL`); the dialog is counted with its first turn that
 * goes to the model (`AssistantLimitsService`), a guest waits for the
 * guests' daily budget; `AssistantPipeline` runs the turn. The provider
 * failing or the day's budget spent — «недоступен», and neither the dialog
 * nor the turn is counted. The person's message and the answer as shown are
 * stored; the model's words never reach a log or the journal.
 */
@Injectable()
export class AssistantService {
  private readonly logger = new Logger("Assistant");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AssistantPipeline) private readonly pipeline: AssistantPipeline,
    @Inject(AssistantLimitsService) private readonly limits: AssistantLimitsService,
    @Inject(ShowcaseService) private readonly showcase: ShowcaseService,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(AiService) private readonly ai: AiService,
    @Inject(AdminSignals) private readonly signals: AdminSignals,
    @Inject(AuditLog) private readonly audit: AuditLog,
    @Inject(Metrics) private readonly metrics: Metrics,
  ) {}

  /** Who asks: the account of a session, or a guest's device (required then). */
  askerOf(session: AuthenticatedSession | null, deviceId: string | undefined): Asker {
    if (session) return { kind: "account", accountId: session.accountId };
    if (!deviceId) {
      throw new ApiException(400, "VALIDATION_ERROR", "A guest names the device", {
        details: [{ path: "deviceId", message: "Required for a guest" }],
      });
    }
    return { kind: "guest", deviceId };
  }

  async send(
    session: AuthenticatedSession | null,
    body: AssistantMessageBody,
    lang: CatalogLanguage,
  ): Promise<AssistantMessageResponse> {
    const asker = this.askerOf(session, body.deviceId);
    const text = normalizeAssistantMessage(body.text);
    if (text === "") {
      throw new ApiException(400, "VALIDATION_ERROR", "The message is empty", {
        details: [{ path: "text", message: "Nothing is left of the message" }],
      });
    }
    const executor = this.database.db;
    const viewer = await this.showcase.viewer(session);
    const maxTurns = await this.settings.get("assistant_max_turns");

    // The dialog: the one named, or a new one for this car.
    let dialog: AssistantDialogRow;
    let car: DialogCar;
    if (body.dialogId) {
      dialog = await this.ownDialog(body.dialogId, asker);
      if (dialog.closedAt !== null || dialog.turns >= maxTurns) {
        throw new ApiException(409, "ASSISTANT_DIALOG_FULL", "Start a new dialog");
      }
      car = await this.carOfDialog(dialog, body.mileageKm);
    } else {
      car = await dialogCarOf(
        executor,
        body.car,
        asker.kind === "account" ? asker.accountId : null,
        body.mileageKm,
      );
      // The city and the dialogs left are checked before anything is stored.
      await this.showcase.chosenCity(executor, body.cityId, lang);
      await this.limits.assertDialogLeft(asker);
      dialog = await this.openDialog(asker, car, body.cityId ?? null, lang);
    }
    const cityId = body.cityId ?? dialog.cityId;
    const city = await this.showcase.chosenCity(executor, cityId ?? undefined, lang);

    // One turn of a dialog at a time, within its turns and only while it is
    // open — checked by the claim itself, so a turn finishing meanwhile or a
    // new dialog closing this one can't be raced past.
    const staleSeconds =
      (await this.settings.get("assistant_turn_seconds")) + TURN_CLAIM_MARGIN_SECONDS;
    const [claimed] = await executor
      .update(assistantDialog)
      // Milliseconds: the claim is released by its own value, read back as a Date.
      .set({ turnStartedAt: sql`date_trunc('milliseconds', now())`, updatedAt: sql`now()` })
      .where(
        and(
          eq(assistantDialog.id, dialog.id),
          isNull(assistantDialog.closedAt),
          lt(assistantDialog.turns, maxTurns),
          or(
            isNull(assistantDialog.turnStartedAt),
            lt(assistantDialog.turnStartedAt, sql`now() - make_interval(secs => ${staleSeconds})`),
          ),
        ),
      )
      .returning();
    if (!claimed) {
      const now = await this.dialogRow(dialog.id);
      if (!now || now.closedAt !== null || now.turns >= maxTurns) {
        throw new ApiException(409, "ASSISTANT_DIALOG_FULL", "Start a new dialog");
      }
      throw new ApiException(409, "ASSISTANT_TURN_IN_PROGRESS", "A turn of this dialog is running");
    }
    dialog = claimed;
    const claim = claimed.turnStartedAt!;
    let charge: Charge | null = null;
    try {
      if (!dialog.charged) {
        charge = await this.limits.charge(asker, dialog.id);
      }
      const initiator: AiInitiator =
        asker.kind === "account"
          ? { type: "account", id: asker.accountId }
          : { type: "guest_device", id: asker.deviceId };

      let outcome: TurnOutcome;
      let unavailableReason: "provider" | "budget" | "guest_budget" | null = null;
      if (asker.kind === "guest" && (await this.guestBudgetSpent())) {
        outcome = { ok: false, reason: "budget", toolCalls: [], foundIds: [], aiJobIds: [] };
        unavailableReason = "guest_budget";
        await this.recordUnavailable(dialog, "guest_budget");
      } else {
        const history = await executor
          .select()
          .from(assistantMessage)
          .where(eq(assistantMessage.dialogId, dialog.id))
          .orderBy(asc(assistantMessage.createdAt), desc(assistantMessage.role));
        outcome = await this.pipeline.turn({
          dialogId: dialog.id,
          context: {
            vehicle: car.vehicle,
            resolved: car.resolved,
            cityId: city?.id ?? null,
            viewer,
            lang,
          },
          car: car.words,
          cityName: city?.name.text ?? null,
          mileageKm: car.mileageKm,
          history,
          text,
          initiator,
        });
        if (!outcome.ok) {
          unavailableReason = outcome.reason;
          await this.recordUnavailable(dialog, outcome.reason);
        }
      }

      const stored = await this.store(
        dialog,
        text,
        outcome,
        unavailableReason ?? "provider",
        lang,
        cityId ?? null,
      );
      if (!outcome.ok && charge) {
        // Not the person's doing: the dialog is given back.
        await this.limits.refund(charge, dialog.id);
        charge = null;
      }
      this.metrics.countAssistantTurn(stored.reply.kind);
      if (outcome.ok) this.metrics.countAssistantGroundingDropped(outcome.dropped);
      const current = await this.dialogRow(dialog.id);
      return {
        dialogId: dialog.id,
        message: stored.reply,
        limits: await this.limits.left(asker, current ?? null),
      };
    } catch (error) {
      // A turn that failed for any other reason is not counted either.
      if (charge) await this.limits.refund(charge, dialog.id);
      throw error;
    } finally {
      // Only this turn's own claim: one taken over as stale belongs to another turn.
      await executor
        .update(assistantDialog)
        .set({ turnStartedAt: null })
        .where(and(eq(assistantDialog.id, dialog.id), eq(assistantDialog.turnStartedAt, claim)));
    }
  }

  async dialogView(
    session: AuthenticatedSession | null,
    deviceId: string | undefined,
    dialogId: string,
    lang: CatalogLanguage,
  ): Promise<AssistantDialogResponse> {
    const asker = this.askerOf(session, deviceId);
    const dialog = await this.ownDialog(dialogId, asker);
    const rows = await this.database.db
      .select()
      .from(assistantMessage)
      .where(eq(assistantMessage.dialogId, dialog.id))
      .orderBy(asc(assistantMessage.createdAt), desc(assistantMessage.role));
    const city = dialog.cityId
      ? await this.showcase.chosenCity(this.database.db, dialog.cityId, lang).catch(() => null)
      : null;
    return {
      dialog: {
        id: dialog.id,
        language: dialog.language,
        car: dialog.carWords,
        city,
        createdAt: dialog.createdAt.toISOString(),
        closedAt: dialog.closedAt?.toISOString() ?? null,
      },
      messages: rows.map((row) =>
        row.role === "user"
          ? {
              id: row.id,
              role: "user" as const,
              createdAt: row.createdAt.toISOString(),
              text: row.text ?? "",
            }
          : replyOf(row),
      ),
      limits: await this.limits.left(asker, dialog),
    };
  }

  left(
    session: AuthenticatedSession | null,
    deviceId: string | undefined,
  ): Promise<AssistantLimits> {
    return this.limits.left(this.askerOf(session, deviceId), null);
  }

  /** «Пожаловаться на ответ»: once per answer of one's own dialog; again — the first one. */
  async complain(
    session: AuthenticatedSession | null,
    messageId: string,
    body: AssistantComplaintBody,
  ): Promise<AssistantComplaintResponse> {
    const asker = this.askerOf(session, body.deviceId);
    const [message] = await this.database.db
      .select()
      .from(assistantMessage)
      .where(and(eq(assistantMessage.id, messageId), eq(assistantMessage.role, "assistant")));
    if (!message) throw new ApiException(404, "NOT_FOUND", "No such answer");
    await this.ownDialog(message.dialogId, asker).catch(() => {
      throw new ApiException(404, "NOT_FOUND", "No such answer");
    });
    const row = await this.database.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(assistantComplaint)
        .values({
          messageId,
          dialogId: message.dialogId,
          reason: body.reason,
          // An answer already impersonal: the complaint keeps no words either.
          text: body.text && body.text.length > 0 && !message.anonymizedAt ? body.text : null,
        })
        .onConflictDoNothing({ target: assistantComplaint.messageId })
        .returning();
      if (created) {
        await this.audit.record(
          {
            action: auditActions.assistantComplaintCreated,
            actor:
              asker.kind === "account"
                ? { role: "user", accountId: asker.accountId }
                : { role: "system" },
            entityType: auditEntities.assistantComplaint,
            entityId: created.id,
            // The reason and the dialog; never the texts.
            after: {
              reason: created.reason,
              dialogId: created.dialogId,
              messageId,
              guest: asker.kind === "guest",
            },
          },
          tx,
        );
        return created;
      }
      const [existing] = await tx
        .select()
        .from(assistantComplaint)
        .where(eq(assistantComplaint.messageId, messageId));
      return existing!;
    });
    return {
      complaint: {
        id: row.id,
        messageId: row.messageId,
        reason: row.reason,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
      },
    };
  }

  /** The dialog, only the asker's own: an account's, or a guest device's (no account). */
  private async ownDialog(dialogId: string, asker: Asker): Promise<AssistantDialogRow> {
    const row = await this.dialogRow(dialogId);
    const own =
      row !== undefined &&
      (asker.kind === "account"
        ? row.accountId === asker.accountId
        : row.accountId === null && row.deviceId === asker.deviceId);
    if (!own) throw notFound();
    return row;
  }

  private async dialogRow(dialogId: string): Promise<AssistantDialogRow | undefined> {
    const [row] = await this.database.db
      .select()
      .from(assistantDialog)
      .where(eq(assistantDialog.id, dialogId));
    return row;
  }

  /** The car of a dialog as it was opened; the mileage as it is now. */
  private async carOfDialog(
    dialog: AssistantDialogRow,
    guestMileageKm: number | undefined,
  ): Promise<DialogCar> {
    if (dialog.carId && dialog.accountId) {
      return dialogCarOf(
        this.database.db,
        { carId: dialog.carId },
        dialog.accountId,
        undefined,
      ).catch(async () => this.levelsCar(dialog, undefined));
    }
    return this.levelsCar(dialog, guestMileageKm);
  }

  private async levelsCar(
    dialog: AssistantDialogRow,
    mileageKm: number | undefined,
  ): Promise<DialogCar> {
    const resolved = await resolveVehicle(this.database.db, dialog.vehicle);
    return {
      vehicle: dialog.vehicle,
      resolved,
      words: dialog.carWords.make ? dialog.carWords : await carWordsOf(this.database.db, resolved),
      carId: dialog.carId,
      mileageKm: mileageKm ?? null,
    };
  }

  /**
   * A new dialog of the asker; their dialogs still open are closed by it
   * (SCREENS M-AI-01: «хранится только текущий диалог»), and the cost of each
   * is observed as a finished dialog's.
   */
  private async openDialog(
    asker: Asker,
    car: DialogCar,
    cityId: string | null,
    lang: CatalogLanguage,
  ): Promise<AssistantDialogRow> {
    const owner =
      asker.kind === "account"
        ? eq(assistantDialog.accountId, asker.accountId)
        : and(isNull(assistantDialog.accountId), eq(assistantDialog.deviceId, asker.deviceId));
    const closed = await this.database.db
      .update(assistantDialog)
      .set({ closedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(owner, isNull(assistantDialog.closedAt)))
      .returning({ id: assistantDialog.id, turns: assistantDialog.turns });
    await this.observeCosts(closed.filter((row) => row.turns > 0).map((row) => row.id));
    const [row] = await this.database.db
      .insert(assistantDialog)
      .values({
        accountId: asker.kind === "account" ? asker.accountId : null,
        deviceId: asker.kind === "guest" ? asker.deviceId : null,
        language: lang,
        vehicle: car.vehicle,
        carWords: car.words,
        carId: car.carId,
        cityId,
      })
      .returning();
    return row!;
  }

  /** The person's message and the answer as shown, the turn counted when it was served. */
  private async store(
    dialog: AssistantDialogRow,
    text: string,
    outcome: TurnOutcome,
    unavailableReason: "provider" | "budget" | "guest_budget",
    lang: CatalogLanguage,
    cityId: string | null,
  ): Promise<{ reply: AssistantReply }> {
    const unavailable: StoredReply = {
      question: null,
      cards: [],
      groups: [],
      total: null,
      orderEachItem: false,
      notOnPlatform: [],
      disclaimer: null,
      mileageSuggestion: null,
      notFound: false,
      unavailable: { reason: unavailableReason },
    };
    return this.database.db.transaction(async (tx) => {
      // Two rows of one transaction share `now()`: a dialog is read back by
      // time, then by role descending — the person's words before the answer.
      await tx.insert(assistantMessage).values({ dialogId: dialog.id, role: "user", text });
      const [answer] = await tx
        .insert(assistantMessage)
        .values(
          outcome.ok
            ? {
                dialogId: dialog.id,
                role: "assistant",
                text: outcome.text,
                kind: outcome.kind,
                intent: outcome.intent,
                itemIds: outcome.itemIds,
                foundItemIds: outcome.foundIds,
                droppedItems: outcome.dropped,
                reply: outcome.reply,
                toolCalls: outcome.toolCalls,
                aiJobIds: outcome.aiJobIds,
              }
            : {
                dialogId: dialog.id,
                role: "assistant",
                text: UNAVAILABLE_TEXT[lang],
                kind: "unavailable",
                reply: unavailable,
                toolCalls: outcome.toolCalls,
                aiJobIds: outcome.aiJobIds,
                foundItemIds: [],
              },
        )
        .returning();
      await tx
        .update(assistantDialog)
        .set({
          ...(outcome.ok ? { turns: sql`${assistantDialog.turns} + 1` } : {}),
          language: lang,
          cityId,
          updatedAt: sql`now()`,
        })
        .where(eq(assistantDialog.id, dialog.id));
      return { reply: replyOf(answer!) };
    });
  }

  private async guestBudgetSpent(): Promise<boolean> {
    const [spent, budget] = await Promise.all([
      this.ai.guestSpentToday(),
      this.settings.get("guest_ai_daily_budget_usd"),
    ]);
    return spent >= budget;
  }

  /**
   * «Недоступен»: counted, and — the whole day's budget spent — a signal to
   * the administrator, at most one an Almaty day (`assistant_budget_exhausted`).
   */
  private async recordUnavailable(
    dialog: AssistantDialogRow,
    reason: "provider" | "budget" | "guest_budget",
  ): Promise<void> {
    this.metrics.countAssistantUnavailable(reason);
    this.logger.warn(`Assistant unavailable dialog=${dialog.id} reason=${reason}`);
    if (reason !== "budget") return;
    try {
      const executor = this.database.db;
      const open = await this.signals.openOf(
        executor,
        "assistant_budget_exhausted",
        "channel",
        ASSISTANT_SUBJECT_ID,
      );
      if (open) return;
      const last = await this.signals.lastClosedOf(
        executor,
        "assistant_budget_exhausted",
        "channel",
        ASSISTANT_SUBJECT_ID,
      );
      if (last) {
        const today = await executor.execute<{ today: boolean }>(
          sql`SELECT ${last.firstSeenAt} >= ${ALMATY_DAY_START} AS today`,
        );
        if (today.rows[0]?.today) return;
      }
      await this.signals.raise(executor, {
        kind: "assistant_budget_exhausted",
        subjectType: "channel",
        subjectId: ASSISTANT_SUBJECT_ID,
        payload: { since: new Date().toISOString() },
        at: new Date(),
      });
    } catch (error) {
      // A signal is a courtesy to the administrator; the person's answer does not wait for it.
      this.logger.error(`Assistant budget signal not raised: ${String(error)}`);
    }
  }

  /** The cost of finished dialogs (the AI calls of all their turns) for the metric. */
  private async observeCosts(dialogIds: readonly string[]): Promise<void> {
    if (dialogIds.length === 0) return;
    const rows = await this.database.db.execute<{ cost: string }>(sql`
      SELECT COALESCE(sum(j.cost_usd), 0)::text AS cost
      FROM assistant_dialog d
      LEFT JOIN assistant_message m ON m.dialog_id = d.id
      LEFT JOIN ${aiJob} j ON j.id = ANY (m.ai_job_ids)
      WHERE d.id IN (${sql.join(
        dialogIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
      GROUP BY d.id`);
    for (const row of rows.rows) this.metrics.observeAssistantDialogCost(Number(row.cost));
  }
}
