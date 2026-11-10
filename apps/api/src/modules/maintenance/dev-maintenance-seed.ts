import { Inject, Injectable } from "@nestjs/common";
import type { MaintenanceScope } from "@adclub/contracts";
import { and, eq, sql } from "drizzle-orm";
import { APP_CONFIG, type AppConfig } from "../../config";
import { DatabaseService } from "../../database";
import { testMaintenanceDraft } from "../ai";
import { mapDraft } from "./maintenance-draft-mapping";
import { MaintenanceDrafts } from "./maintenance-draft.service";
import { MaintenancePlansService, type MaintenanceActor } from "./maintenance-plans.service";
import { sameScopeWhere } from "./maintenance-scope";
import { maintenancePlan } from "./schema";

export class DevMaintenanceSeedError extends Error {}

export interface DevMaintenanceSeedResult {
  created: { plans: number; items: number };
  existing: { plans: number };
}

const OPERATOR: MaintenanceActor = { role: "operator" };

/**
 * Example maintenance plans for development and tests (TASK-061
 * requirement 3), on top of the catalog and vehicle seeds, through the
 * administrator's service: active `manual` plans of Geely (the whole
 * make), of the Geely Coolray with the JLH-3G15TD engine (the finer one)
 * and of the Chery Tiggo 7 Pro — the elements of the test draft
 * (`testMaintenanceDraft`) that lead to the catalog (the rule-less brake
 * fluid is left out). A manual plan of an area that already exists, in any
 * status, is left as it is: a second run creates nothing.
 */
@Injectable()
export class DevMaintenanceSeed {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(MaintenancePlansService) private readonly plans: MaintenancePlansService,
    @Inject(MaintenanceDrafts) private readonly drafts: MaintenanceDrafts,
  ) {}

  async run(): Promise<DevMaintenanceSeedResult> {
    if (this.config.nodeEnv !== "development" && this.config.nodeEnv !== "test") {
      throw new DevMaintenanceSeedError(
        "Maintenance plans are kept by the administrator; the example data is for development and tests only",
      );
    }
    const result: DevMaintenanceSeedResult = {
      created: { plans: 0, items: 0 },
      existing: { plans: 0 },
    };
    const geely = await this.one(
      "the make Geely (run dev:vehicles:seed first)",
      sql`SELECT make_id AS id FROM vehicle_make_spelling WHERE key = 'geely'`,
    );
    const coolray = await this.one(
      "the model Coolray",
      sql`SELECT model_id AS id FROM vehicle_model_spelling WHERE make_id = ${geely}::uuid AND key = 'coolray'`,
    );
    const engine = await this.one(
      "the engine JLH-3G15TD",
      sql`SELECT engine_id AS id FROM vehicle_engine_spelling WHERE key = 'jlh-3g15td'`,
    );
    const chery = await this.one(
      "the make Chery",
      sql`SELECT make_id AS id FROM vehicle_make_spelling WHERE key = 'chery'`,
    );
    const tiggo = await this.one(
      "the model Tiggo 7 Pro",
      sql`SELECT model_id AS id FROM vehicle_model_spelling WHERE make_id = ${chery}::uuid AND key = 'tiggo7pro'`,
    );
    const wanted: [MaintenanceScope, string][] = [
      [{ makeId: geely, modelId: null, generationId: null, engineId: null }, "Geely — общий"],
      [
        { makeId: geely, modelId: coolray, generationId: null, engineId: engine },
        "Geely Coolray, 1.5T",
      ],
      [{ makeId: chery, modelId: tiggo, generationId: null, engineId: null }, "Chery Tiggo 7 Pro"],
    ];
    for (const [scope, name] of wanted) {
      const [existing] = await this.database.db
        .select({ id: maintenancePlan.id })
        .from(maintenancePlan)
        .where(and(sameScopeWhere(scope), eq(maintenancePlan.source, "manual")));
      if (existing) {
        result.existing.plans += 1;
        continue;
      }
      const { input, categories } = await this.drafts.draftInput(this.database.db, scope);
      const elements = mapDraft(testMaintenanceDraft(input), categories).elements.filter(
        (element) => element.target !== null,
      );
      const written = await this.database.db.transaction(async (tx) => {
        const plan = await this.plans.insertPlan(tx, {
          scope,
          name,
          source: "manual",
          actor: OPERATOR,
          copiedFromId: null,
        });
        for (const element of elements) {
          await this.plans.insertElement(tx, plan, OPERATOR, { ...element, status: "active" });
        }
        return plan;
      });
      // Activated as the administrator does it: the checks and the journal are the same.
      await this.plans.setStatus(
        written.id,
        { expectedVersion: written.version, status: "active" },
        OPERATOR,
      );
      result.created.plans += 1;
      result.created.items += elements.length;
    }
    return result;
  }

  private async one(what: string, query: ReturnType<typeof sql>): Promise<string> {
    const found = await this.database.db.execute<{ id: string }>(query);
    const id = found.rows[0]?.id;
    if (!id) throw new DevMaintenanceSeedError(`Not found: ${what}`);
    return id;
  }
}
