import { Inject, Injectable } from "@nestjs/common";
import {
  auditActions,
  auditEntities,
  type AnnouncedPlan,
  type SubscriptionPlan,
} from "@adclub/contracts";
import { announcedPlan, planInEffect, type SubscriptionAudience } from "@adclub/domain";
import { and, asc, eq } from "drizzle-orm";
import { ApiException } from "../../common/errors";
import { DatabaseService, type DbExecutor } from "../../database";
import { AuditLog } from "../audit";
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

const CODE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PRICE_MAX = 1_000_000;

function invalid(path: string, message: string): ApiException {
  return new ApiException(400, "VALIDATION_ERROR", message, { details: [{ path, message }] });
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

/**
 * Tariffs (PRODUCT 14.1, 14.2; ARCHITECTURE 5.10, 4.72; TASK-040): records
 * with dates. Which one is in effect on a date and which one is announced
 * are the two functions of `@adclub/domain` (`planInEffect`,
 * `announcedPlan`); this reads the records and adds new ones (the operator
 * command; the admin screen — TASK-043), each one in the journal.
 */
@Injectable()
export class Plans {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditLog) private readonly audit: AuditLog,
    @Inject(AppSettings) private readonly settings: AppSettings,
  ) {}

  async all(executor: DbExecutor = this.database.db): Promise<PlanRow[]> {
    return executor.select().from(plan).orderBy(asc(plan.audience), asc(plan.validFrom));
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

  /** A new tariff record (a rise — a record with a future date); the journal records it. */
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
      const [taken] = await tx
        .select({ id: plan.id })
        .from(plan)
        .where(and(eq(plan.audience, input.audience), eq(plan.validFrom, input.validFrom)));
      if (taken) {
        throw invalid("validFrom", "A tariff of this audience already starts at this moment");
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
          reason,
          createdByRole: actor.role,
        })
        .returning();
      await this.audit.record(
        {
          action: auditActions.planAdded,
          actor: { role: "operator" },
          entityType: auditEntities.plan,
          entityId: row!.id,
          after: {
            audience: row!.audience,
            code: row!.code,
            price: row!.price,
            currency: row!.currency,
            period: row!.period,
            validFrom: row!.validFrom.toISOString(),
            validTo: row!.validTo?.toISOString() ?? null,
            announceBeforeDays: row!.announceBeforeDays,
          },
          reason,
        },
        tx,
      );
      return row!;
    });
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
}
