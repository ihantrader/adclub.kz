import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  MAINTENANCE_PLAN_ITEMS_MAX,
  type AdminMaintenancePlanResponse,
  type DraftMaintenancePlanBody,
} from "@adclub/contracts";
import { and, asc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { DatabaseService, type DbExecutor } from "../../database";
import {
  AiBudgetExhaustedError,
  AiGatewayError,
  AiService,
  type MaintenanceDraftCategory,
  type MaintenanceDraftInput,
} from "../ai";
import { attribute, attributeOption, category, loadTexts, textsOf } from "../catalog";
import {
  vehicleEngine,
  vehicleEngineSpelling,
  vehicleGeneration,
  vehicleMakeSpelling,
  vehicleModelSpelling,
  vehicleOption,
} from "../vehicles";
import { aiUnavailable, draftInProgress, planState } from "./maintenance-errors";
import { mapDraft, type DraftCatalogCategory } from "./maintenance-draft-mapping";
import { MaintenancePlansService, type MaintenanceActor } from "./maintenance-plans.service";
import { resolveScope, sameScopeWhere, STALE_GENERATION_MS } from "./maintenance-scope";
import { planResponse } from "./maintenance-views";
import { maintenancePlan, maintenancePlanItem } from "./schema";

/** The mileage a draft covers (TASK-061 requirement 3). */
export const MAINTENANCE_DRAFT_HORIZON_KM = 60_000;

/**
 * The longest an administrator waits for a draft: both models together
 * (TASK-061 requirement 3, TASK-061.A). A row «being generated» much longer
 * than this is a process that died (`STALE_GENERATION_MS`).
 */
export const MAINTENANCE_DRAFT_DEADLINE_MS = 60_000;

const GENERATING_KEY = "maintenance_plan_generating_scope_key";

function uniqueViolation(error: unknown, constraint: string): boolean {
  for (let current: unknown = error; current; current = (current as { cause?: unknown }).cause) {
    const candidate = current as { code?: unknown; constraint?: unknown };
    if (candidate.code === "23505" && candidate.constraint === constraint) return true;
    if (current === (current as { cause?: unknown }).cause) break;
  }
  return false;
}

/** What a draft cost and how it went, besides the plan (the operator command prints it). */
export interface DraftOutcome {
  response: AdminMaintenancePlanResponse;
  aiJobId: string;
  model: string;
  usedFallback: boolean;
  dropped: number;
  unmapped: number;
}

/**
 * The first draft of a plan made by AI (TASK-061 requirement 3; ARCHITECTURE
 * 4.84, 11.3): a new plan `draft` / `ai_draft` whose elements are
 * `proposed` — AI never activates anything nor touches an active plan. The
 * model is told the car as the vehicle catalog names it and our active
 * subcategories with their filters, and answers in their codes; the answer
 * is mapped onto the catalog (`mapDraft`). Synchronous: an administrator
 * waits for it on the screen, so no queue — the row is written first with
 * `generating_since` (one draft at a time per area, by a unique index) and
 * removed if AI fails. The call goes through `AiService`: the daily budget,
 * the fallback model and `ai_job` (without the texts) are the common ones.
 */
@Injectable()
export class MaintenanceDrafts {
  private readonly logger = new Logger("Maintenance");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AiService) private readonly ai: AiService,
    @Inject(MaintenancePlansService) private readonly plans: MaintenancePlansService,
  ) {}

  async draft(
    body: DraftMaintenancePlanBody,
    actor: MaintenanceActor,
    options: { model?: string } = {},
  ): Promise<DraftOutcome> {
    const executor = this.database.db;
    const scope = await resolveScope(executor, body.scope);
    let planId: string;
    try {
      planId = await executor.transaction(async (tx) => {
        await tx
          .delete(maintenancePlan)
          .where(
            and(
              sameScopeWhere(scope),
              isNotNull(maintenancePlan.generatingSince),
              lt(maintenancePlan.generatingSince, new Date(Date.now() - STALE_GENERATION_MS)),
              sql`NOT EXISTS (SELECT 1 FROM ${maintenancePlanItem} WHERE ${maintenancePlanItem.planId} = ${maintenancePlan.id})`,
            ),
          );
        const row = await this.plans.insertPlan(tx, {
          scope,
          name: body.name ?? null,
          source: "ai_draft",
          actor,
          copiedFromId: null,
          generatingSince: new Date(),
          record: false,
        });
        return row.id;
      });
    } catch (error) {
      if (uniqueViolation(error, GENERATING_KEY)) throw draftInProgress();
      throw error;
    }

    const { input, categories } = await this.draftInput(executor, scope);
    let result: Awaited<ReturnType<AiService["draftMaintenancePlan"]>>;
    try {
      result = await this.ai.draftMaintenancePlan(input, {
        initiator:
          actor.role === "admin" ? { type: "account", id: actor.accountId } : { type: "system" },
        inputRef: {
          planId,
          scope,
          categories: input.categories.length,
          horizonKm: input.horizonKm,
        },
        ...(options.model === undefined ? {} : { model: options.model }),
        deadlineMs: MAINTENANCE_DRAFT_DEADLINE_MS,
      });
    } catch (error) {
      await executor.delete(maintenancePlan).where(eq(maintenancePlan.id, planId));
      if (error instanceof AiGatewayError || error instanceof AiBudgetExhaustedError) {
        this.logger.warn(
          `Maintenance draft failed plan=${planId} kind=${error instanceof AiGatewayError ? error.kind : "budget"}`,
        );
        throw aiUnavailable();
      }
      throw error;
    }

    const mapped = mapDraft(result.output, categories);
    // A plan holds at most MAINTENANCE_PLAN_ITEMS_MAX elements: the rest of an over-long answer is dropped.
    const elements = mapped.elements.slice(0, MAINTENANCE_PLAN_ITEMS_MAX);
    const dropped = mapped.dropped + (mapped.elements.length - elements.length);
    const response = await executor.transaction(async (tx) => {
      const plan = await this.plans.lockPlan(tx, planId);
      if (plan.generatingSince === null) {
        // Archived as a dead draft meanwhile: it stays as the administrator left it.
        throw planState("The draft was archived while AI was making it");
      }
      for (const element of elements) {
        await this.plans.insertElement(tx, plan, actor, element);
      }
      const [written] = await tx
        .update(maintenancePlan)
        .set({ generatingSince: null, aiJobId: result.jobId, updatedAt: new Date() })
        .where(eq(maintenancePlan.id, planId))
        .returning();
      await this.plans.recordCreated(tx, written!, actor);
      return planResponse(tx, written!);
    });
    this.logger.log(
      `Maintenance draft made plan=${planId} elements=${String(elements.length)} unmapped=${String(mapped.unmapped)} dropped=${String(dropped)} model=${result.model}`,
    );
    return {
      response,
      aiJobId: result.jobId,
      model: result.model,
      usedFallback: result.usedFallback,
      dropped,
      unmapped: mapped.unmapped,
    };
  }

  /**
   * What the model is told: the car as the vehicle catalog names it (no
   * person, no garage), and every active subcategory under an active node
   * with its active filters and their variants (Russian names, codes).
   */
  async draftInput(
    executor: DbExecutor,
    scope: {
      makeId: string;
      modelId: string | null;
      generationId: string | null;
      engineId: string | null;
    },
  ): Promise<{ input: MaintenanceDraftInput; categories: DraftCatalogCategory[] }> {
    const name = async (
      table: typeof vehicleMakeSpelling | typeof vehicleModelSpelling,
      column: typeof vehicleMakeSpelling.makeId | typeof vehicleModelSpelling.modelId,
      id: string | null,
    ) => {
      if (id === null) return null;
      const [row] = await executor
        .select({ text: table.text })
        .from(table)
        .where(and(eq(column, id), eq(table.isName, true)));
      return row?.text ?? null;
    };
    const make = (await name(vehicleMakeSpelling, vehicleMakeSpelling.makeId, scope.makeId)) ?? "";
    const model = await name(vehicleModelSpelling, vehicleModelSpelling.modelId, scope.modelId);
    const [generation] = scope.generationId
      ? await executor
          .select()
          .from(vehicleGeneration)
          .where(eq(vehicleGeneration.id, scope.generationId))
      : [];
    let engine: MaintenanceDraftInput["vehicle"]["engine"] = null;
    if (scope.engineId) {
      const [row] = await executor
        .select({
          code: vehicleEngineSpelling.text,
          displacementL: vehicleEngine.displacementL,
          powerHp: vehicleEngine.powerHp,
          fuel: vehicleOption.nameRu,
        })
        .from(vehicleEngine)
        .innerJoin(
          vehicleEngineSpelling,
          and(
            eq(vehicleEngineSpelling.engineId, vehicleEngine.id),
            eq(vehicleEngineSpelling.isCode, true),
          ),
        )
        .leftJoin(vehicleOption, eq(vehicleOption.id, vehicleEngine.fuelId))
        .where(eq(vehicleEngine.id, scope.engineId));
      if (row) {
        engine = {
          code: row.code,
          displacementL: row.displacementL === null ? null : Number(row.displacementL),
          fuel: row.fuel,
          powerHp: row.powerHp,
        };
      }
    }

    const nodes = await executor
      .select({ id: category.id })
      .from(category)
      .where(and(eq(category.level, 1), eq(category.status, "active")));
    const subcategories =
      nodes.length === 0
        ? []
        : await executor
            .select()
            .from(category)
            .where(
              and(
                eq(category.level, 2),
                eq(category.status, "active"),
                inArray(
                  category.parentId,
                  nodes.map((node) => node.id),
                ),
              ),
            )
            .orderBy(asc(category.sort), asc(category.code));
    const attributes =
      subcategories.length === 0
        ? []
        : await executor
            .select()
            .from(attribute)
            .where(
              and(
                inArray(
                  attribute.categoryId,
                  subcategories.map((row) => row.id),
                ),
                eq(attribute.status, "active"),
                eq(attribute.isFilterable, true),
              ),
            )
            .orderBy(asc(attribute.sort), asc(attribute.code));
    const options =
      attributes.length === 0
        ? []
        : await executor
            .select()
            .from(attributeOption)
            .where(
              and(
                inArray(
                  attributeOption.attributeId,
                  attributes.map((row) => row.id),
                ),
                eq(attributeOption.status, "active"),
              ),
            )
            .orderBy(asc(attributeOption.sort), asc(attributeOption.code));
    const [categoryTexts, attributeTexts, optionTexts] = await Promise.all([
      loadTexts(
        executor,
        "category",
        subcategories.map((row) => row.id),
      ),
      loadTexts(
        executor,
        "attribute",
        attributes.map((row) => row.id),
      ),
      loadTexts(
        executor,
        "attribute_option",
        options.map((row) => row.id),
      ),
    ]);
    const ru = (index: typeof categoryTexts, id: string, field: "name" | "unit" = "name") =>
      textsOf(index, id, field).ru?.text ?? null;

    const categories: DraftCatalogCategory[] = subcategories.map((row) => ({
      id: row.id,
      code: row.code,
      kind: row.kind,
      attributes: attributes
        .filter((entry) => entry.categoryId === row.id)
        .map((entry) => ({
          id: entry.id,
          code: entry.code,
          type: entry.valueType,
          options: options
            .filter((option) => option.attributeId === entry.id)
            .map((option) => ({ id: option.id, code: option.code })),
        })),
    }));
    const described: MaintenanceDraftCategory[] = subcategories.map((row) => ({
      code: row.code,
      kind: row.kind,
      name: ru(categoryTexts, row.id) ?? row.code,
      attributes: attributes
        .filter((entry) => entry.categoryId === row.id && entry.valueType !== "text")
        .map((entry) => ({
          code: entry.code,
          name: ru(attributeTexts, entry.id) ?? entry.code,
          type: entry.valueType === "bool" ? "boolean" : entry.valueType,
          unit: ru(attributeTexts, entry.id, "unit"),
          options: options
            .filter((option) => option.attributeId === entry.id)
            .map((option) => ({
              code: option.code,
              name: ru(optionTexts, option.id) ?? option.code,
            })),
        })),
    }));
    return {
      input: {
        vehicle: {
          make,
          model,
          generation: generation?.name ?? null,
          yearFrom: generation?.yearFrom ?? null,
          yearTo: generation?.yearTo ?? null,
          engine,
        },
        horizonKm: MAINTENANCE_DRAFT_HORIZON_KM,
        categories: described,
      },
      categories,
    };
  }
}
