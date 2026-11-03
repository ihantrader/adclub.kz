import { Inject, Injectable } from "@nestjs/common";
import {
  auditActions,
  auditEntities,
  type AddAdminPlanBody,
  type AdminBillingPlans,
  type AdminPlan,
  type AnnouncedPlan,
  type PlanVersionConflictDetails,
  type SubscriptionPlan,
} from "@adclub/contracts";
import {
  announcedPlan,
  BILLING_TIME_ZONE,
  earliestPlanStart,
  localDateTime,
  planInEffect,
  startOfLocalDate,
  type SubscriptionAudience,
} from "@adclub/domain";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { ApiException } from "../../common/errors";
import { DatabaseService, type DbExecutor } from "../../database";
import { AuditLog, type AuditActorRecord } from "../audit";
import { AppSettings } from "../settings";
import { plan, type PlanRow } from "./schema";

export interface NewPlan {
  audience: SubscriptionAudience;
  code: string;
  price: number;
  validFrom: Date;
  validTo: Date | null;
  announceBeforeDays: number;
  reason: string;
}

/** Who adds or cancels a tariff: the server's command, or an administrator of the panel. */
export type PlanActor =
  { role: "operator" } | { role: "admin"; accountId: string; adminId: string };

const CODE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PRICE_MAX = 1_000_000;
const DAY_MS = 86_400_000;

function invalid(path: string, message: string, extra?: Record<string, unknown>): ApiException {
  return new ApiException(400, "VALIDATION_ERROR", message, {
    details: [{ path, message, ...extra }],
  });
}

function planView(row: PlanRow): SubscriptionPlan {
  return {
    code: row.code,
    price: row.price,
    currency: row.currency,
    period: row.period,
    validFrom: row.validFrom.toISOString(),
  };
}

function versionConflict(currentVersion: number): ApiException {
  const details: PlanVersionConflictDetails = { currentVersion };
  return new ApiException(
    409,
    "PLAN_VERSION_CONFLICT",
    "The tariffs were changed by someone else; reload them and decide again",
    { details },
  );
}

/** A serialisation of every change of the tariffs (both audiences): one at a time. */
const PLAN_LOCK = sql`pg_advisory_xact_lock(hashtext('billing:plan'))`;

/**
 * Tariffs (PRODUCT 14.1, 14.2; ARCHITECTURE 5.10, 4.72, 4.78; TASK-040,
 * TASK-043): records with dates. Which one is in effect on a date and which
 * one is announced are the two functions of `@adclub/domain`
 * (`planInEffect`, `announcedPlan`), asked only of the records that are not
 * cancelled. **The one place a record is added or cancelled**, for the
 * operator command and the admin panel alike, each one in the journal; the
 * panel's rules of a new record (a later day, a rise no earlier than its
 * notice — `earliestPlanStart`) are the administrator's, the command keeps
 * the server's latitude (as with the settings, D-053).
 */
@Injectable()
export class Plans {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditLog) private readonly audit: AuditLog,
    @Inject(AppSettings) private readonly settings: AppSettings,
  ) {}

  /** The records in force: not cancelled. Every reader of «the tariff» takes these. */
  async all(executor: DbExecutor = this.database.db): Promise<PlanRow[]> {
    return executor
      .select()
      .from(plan)
      .where(isNull(plan.cancelledAt))
      .orderBy(asc(plan.audience), asc(plan.validFrom));
  }

  async inEffect(
    audience: SubscriptionAudience,
    at: Date,
    executor: DbExecutor = this.database.db,
  ): Promise<PlanRow | null> {
    return planInEffect(await this.all(executor), audience, at);
  }

  /**
   * The tariff in effect now and the announced change, as the screens show
   * them; the notice is `price_increase_notice_text` in `language`.
   */
  async forScreens(
    audience: SubscriptionAudience,
    language: "kk" | "ru" | "en",
    at: Date = new Date(),
  ): Promise<{ plan: SubscriptionPlan | null; announcedPlan: AnnouncedPlan | null }> {
    const plans = await this.all();
    const current = planInEffect(plans, audience, at);
    const next = announcedPlan(plans, audience, at);
    const notice = next ? (await this.settings.get("price_increase_notice_text"))[language] : "";
    return {
      plan: current ? planView(current) : null,
      announcedPlan: next ? { ...planView(next), notice } : null,
    };
  }

  /** A new tariff record by the operator command (a rise — a record with a future date). */
  async add(input: NewPlan, actor: { role: "operator" }): Promise<PlanRow> {
    if (!CODE.test(input.code)) {
      throw invalid("code", "Lowercase latin letters, digits and dashes, up to 64");
    }
    if (!Number.isInteger(input.price) || input.price < 1 || input.price > PRICE_MAX) {
      throw invalid("price", `A whole number of tenge, 1–${String(PRICE_MAX)}`);
    }
    if (Number.isNaN(input.validFrom.getTime())) {
      throw invalid("validFrom", "Not a moment");
    }
    if (input.validTo && !(input.validTo.getTime() > input.validFrom.getTime())) {
      throw invalid("validTo", "Must be after validFrom");
    }
    if (
      !Number.isInteger(input.announceBeforeDays) ||
      input.announceBeforeDays < 0 ||
      input.announceBeforeDays > 365
    ) {
      throw invalid("announceBeforeDays", "A whole number of days, 0–365");
    }
    const reason = input.reason.trim();
    if (reason.length === 0) {
      throw invalid("reason", "Must not be empty");
    }
    return this.database.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT ${PLAN_LOCK}`);
      return this.insert(tx, { ...input, reason }, actor);
    });
  }

  /**
   * «Запланировать изменение…» of the suppliers' tariff (A-BILL-04): from a
   * later day of Almaty (today — only the very first tariff); a rise no
   * earlier than `announceBeforeDays` days from now, the refusal naming the
   * nearest day allowed; the version the page saw — another administrator's
   * change meanwhile is `PLAN_VERSION_CONFLICT`, never a second record.
   */
  async addByAdmin(
    body: AddAdminPlanBody,
    actor: Extract<PlanActor, { role: "admin" }>,
  ): Promise<AdminBillingPlans> {
    await this.database.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT ${PLAN_LOCK}`);
      const current = await this.versionOf(tx);
      if (current !== body.expectedVersion) throw versionConflict(current);
      const now = new Date();
      const plans = await this.all(tx);
      const validFrom = startOfLocalDate(body.startsOn, BILLING_TIME_ZONE);
      const firstTariff = planInEffect(plans, "supplier", now) === null;
      const before = planInEffect(plans, "supplier", new Date(validFrom.getTime() - 1));
      const rise = before !== null && body.price > before.price;
      if (rise && body.announceBeforeDays < 1) {
        throw invalid("announceBeforeDays", "A rise is announced at least one day ahead");
      }
      const earliest = earliestPlanStart({
        now,
        announceBeforeDays: body.announceBeforeDays,
        rise,
        firstTariff,
      });
      if (body.startsOn < earliest) {
        throw invalid(
          "startsOn",
          rise
            ? `A rise can start no earlier than ${earliest}: the suppliers are told ${String(body.announceBeforeDays)} days ahead`
            : `The tariff can start no earlier than ${earliest}`,
          { earliest, rise },
        );
      }
      await this.insert(
        tx,
        {
          audience: "supplier",
          code: `supplier-${body.startsOn}`,
          price: body.price,
          validFrom,
          validTo: null,
          announceBeforeDays: body.announceBeforeDays,
          reason: body.reason.trim(),
        },
        actor,
      );
    });
    return this.forAdmin();
  }

  /**
   * «Отменить запланированное…»: a suppliers' record that has not started
   * is marked cancelled (never deleted — the history shows it); its notice
   * leaves the cabinet at once, as nothing is announced any more.
   */
  async cancelByAdmin(
    planId: string,
    input: { reason: string; expectedVersion: number },
    actor: Extract<PlanActor, { role: "admin" }>,
  ): Promise<AdminBillingPlans> {
    await this.database.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT ${PLAN_LOCK}`);
      const [row] = await tx.select().from(plan).where(eq(plan.id, planId)).for("update");
      if (!row || row.audience !== "supplier") {
        throw new ApiException(404, "NOT_FOUND", "No such tariff");
      }
      const current = await this.versionOf(tx);
      if (current !== input.expectedVersion) throw versionConflict(current);
      if (row.cancelledAt || row.validFrom.getTime() <= Date.now()) {
        throw new ApiException(
          409,
          "PLAN_NOT_CANCELLABLE",
          row.cancelledAt ? "The tariff is cancelled already" : "The tariff has started already",
        );
      }
      const reason = input.reason.trim();
      const [cancelled] = await tx
        .update(plan)
        .set({ cancelledAt: sql`now()`, cancelledByRole: actor.role, cancelReason: reason })
        .where(eq(plan.id, planId))
        .returning();
      await this.audit.record(
        {
          action: auditActions.planCancelled,
          actor: this.auditActor(actor),
          entityType: auditEntities.plan,
          entityId: row.id,
          before: this.journalOf(row),
          after: { cancelledAt: cancelled!.cancelledAt!.toISOString() },
          reason,
        },
        tx,
      );
    });
    return this.forAdmin();
  }

  /** A-BILL-04: every record, the ones in effect and announced, the version and the earliest day. */
  async forAdmin(at: Date = new Date()): Promise<AdminBillingPlans> {
    const [records, version] = await Promise.all([
      this.database.db.select().from(plan).orderBy(desc(plan.validFrom), desc(plan.createdAt)),
      this.versionOf(this.database.db),
    ]);
    const live = records.filter((row) => row.cancelledAt === null);
    const side = (audience: SubscriptionAudience) => {
      const inEffect = planInEffect(live, audience, at);
      const announced = announcedPlan(live, audience, at);
      return {
        inEffect: inEffect ? this.adminView(inEffect, inEffect, announced, at) : null,
        announced: announced ? this.adminView(announced, inEffect, announced, at) : null,
        records: records
          .filter((row) => row.audience === audience)
          .map((row) => this.adminView(row, inEffect, announced, at)),
      };
    };
    return {
      version,
      supplier: side("supplier"),
      user: side("user"),
      earliestStart: earliestPlanStart({
        now: at,
        announceBeforeDays: 0,
        rise: false,
        firstTariff: planInEffect(live, "supplier", at) === null,
      }),
      today: localDateTime(at, BILLING_TIME_ZONE).date,
    };
  }

  /** The record in effect now and the nearest one after it (announced or not yet). */
  async supplierNow(at: Date = new Date()): Promise<{
    inEffect: AdminPlan | null;
    next: AdminPlan | null;
  }> {
    const live = await this.all();
    const inEffect = planInEffect(live, "supplier", at);
    const announced = announcedPlan(live, "supplier", at);
    const next =
      live
        .filter((row) => row.audience === "supplier" && row.validFrom.getTime() > at.getTime())
        .sort((a, b) => a.validFrom.getTime() - b.validFrom.getTime())[0] ?? null;
    return {
      inEffect: inEffect ? this.adminView(inEffect, inEffect, announced, at) : null,
      next: next ? this.adminView(next, inEffect, announced, at) : null,
    };
  }

  /** The operator's view: every record, and per audience the one in effect and the announced one. */
  async overview(at: Date = new Date()) {
    const plans = await this.all();
    const describe = (row: PlanRow | null) =>
      row && {
        id: row.id,
        audience: row.audience,
        code: row.code,
        price: row.price,
        validFrom: row.validFrom.toISOString(),
        validTo: row.validTo?.toISOString() ?? null,
        announceBeforeDays: row.announceBeforeDays,
      };
    return {
      user: {
        inEffect: describe(planInEffect(plans, "user", at)),
        announced: describe(announcedPlan(plans, "user", at)),
      },
      supplier: {
        inEffect: describe(planInEffect(plans, "supplier", at)),
        announced: describe(announcedPlan(plans, "supplier", at)),
      },
      plans: plans.map(describe),
    };
  }

  /** Grows with every record added and every one cancelled. */
  private async versionOf(executor: DbExecutor): Promise<number> {
    const [row] = await executor
      .select({ value: sql<number>`(count(*) + count(${plan.cancelledAt}))::int` })
      .from(plan);
    return row?.value ?? 0;
  }

  private async insert(tx: DbExecutor, input: NewPlan, actor: PlanActor): Promise<PlanRow> {
    const [taken] = await tx
      .select({ id: plan.id })
      .from(plan)
      .where(
        and(
          eq(plan.audience, input.audience),
          eq(plan.validFrom, input.validFrom),
          isNull(plan.cancelledAt),
        ),
      );
    if (taken) {
      throw invalid(
        actor.role === "admin" ? "startsOn" : "validFrom",
        "A tariff of this audience already starts at this moment",
      );
    }
    const [row] = await tx
      .insert(plan)
      .values({
        audience: input.audience,
        code: input.code,
        price: input.price,
        validFrom: input.validFrom,
        validTo: input.validTo,
        announceBeforeDays: input.announceBeforeDays,
        reason: input.reason,
        createdByRole: actor.role,
      })
      .returning();
    await this.audit.record(
      {
        action: auditActions.planAdded,
        actor: this.auditActor(actor),
        entityType: auditEntities.plan,
        entityId: row!.id,
        after: this.journalOf(row!),
        reason: input.reason,
      },
      tx,
    );
    return row!;
  }

  private auditActor(actor: PlanActor): AuditActorRecord {
    return actor.role === "admin"
      ? { role: "admin", accountId: actor.accountId, adminId: actor.adminId }
      : { role: "operator" };
  }

  private journalOf(row: PlanRow) {
    return {
      audience: row.audience,
      code: row.code,
      price: row.price,
      currency: row.currency,
      period: row.period,
      validFrom: row.validFrom.toISOString(),
      validTo: row.validTo?.toISOString() ?? null,
      announceBeforeDays: row.announceBeforeDays,
    };
  }

  private adminView(
    row: PlanRow,
    inEffect: PlanRow | null,
    announced: PlanRow | null,
    at: Date,
  ): AdminPlan {
    const state: AdminPlan["state"] = row.cancelledAt
      ? "cancelled"
      : row.id === inEffect?.id
        ? "in_effect"
        : row.validFrom.getTime() <= at.getTime()
          ? "past"
          : row.id === announced?.id ||
              row.validFrom.getTime() - row.announceBeforeDays * DAY_MS <= at.getTime()
            ? "announced"
            : "scheduled";
    return {
      id: row.id,
      audience: row.audience,
      code: row.code,
      price: row.price,
      currency: row.currency,
      validFrom: row.validFrom.toISOString(),
      validTo: row.validTo?.toISOString() ?? null,
      announceBeforeDays: row.announceBeforeDays,
      announceFrom: new Date(
        row.validFrom.getTime() - row.announceBeforeDays * DAY_MS,
      ).toISOString(),
      reason: row.reason,
      createdByRole: row.createdByRole,
      createdAt: row.createdAt.toISOString(),
      state,
      cancelled:
        row.cancelledAt && row.cancelledByRole && row.cancelReason
          ? {
              at: row.cancelledAt.toISOString(),
              byRole: row.cancelledByRole,
              reason: row.cancelReason,
            }
          : null,
    };
  }
}
