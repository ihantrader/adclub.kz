import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  auditActions,
  auditEntities,
  type AdminMaintenancePlanPage,
  type AdminMaintenancePlanResponse,
  type ConfirmMaintenanceItemsResponse,
  type CopyMaintenancePlanBody,
  type CreateMaintenanceItemBody,
  type CreateMaintenancePlanBody,
  type MaintenanceItemKind,
  type MaintenanceNotReadyDetails,
  type MaintenancePlanListQuery,
  type MaintenancePlanSource,
  type MaintenanceScope,
  type MaintenanceTarget,
  type ReorderMaintenanceItemsBody,
  type SetMaintenanceItemStatusBody,
  type SetMaintenancePlanStatusBody,
  type UpdateMaintenanceItemBody,
  type UpdateMaintenancePlanBody,
} from "@adclub/contracts";
import { maintenanceIntervalsProblem } from "@adclub/domain";
import { and, asc, count, desc, eq, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import { DatabaseService, type DbExecutor } from "../../database";
import { AuditLog, type AuditActorRecord } from "../audit";
import {
  decodeCursor,
  encodeCursor,
  escapeLike,
  loadTexts,
  plainTexts,
  textsOf,
  TranslationQueue,
} from "../catalog";
import { vehicleEngineSpelling, vehicleMakeSpelling, vehicleModelSpelling } from "../vehicles";
import {
  activeExists,
  notFound,
  notReady,
  planState,
  validationError,
  versionConflict,
} from "./maintenance-errors";
import {
  describeScopes,
  resolveScope,
  sameScope,
  sameScopeWhere,
  scopeOf,
  scopeText,
} from "./maintenance-scope";
import { assertTarget, describeTargets, storedTarget, targetOf } from "./maintenance-targets";
import { describePlans, itemOrder, planResponse } from "./maintenance-views";
import {
  maintenancePlan,
  maintenancePlanItem,
  type MaintenancePlanItemRow,
  type MaintenancePlanRow,
} from "./schema";

/** Who keeps plans: an administrator, or the operator command (the dev seed, a real draft). */
export type MaintenanceActor = Extract<AuditActorRecord, { role: "admin" } | { role: "operator" }>;

const adminOf = (actor: MaintenanceActor): string | null =>
  actor.role === "admin" ? actor.adminId : null;

const ACTIVE_SCOPE_KEY = "maintenance_plan_active_scope_key";

function uniqueViolation(error: unknown, constraint: string): boolean {
  for (let current: unknown = error; current; current = (current as { cause?: unknown }).cause) {
    const candidate = current as { code?: unknown; constraint?: unknown };
    if (candidate.code === "23505" && candidate.constraint === constraint) return true;
    if (current === (current as { cause?: unknown }).cause) break;
  }
  return false;
}

/** An element as it is to be written (a new one, a copy, one of an AI draft). */
export interface NewElement {
  kind: MaintenanceItemKind;
  title: { ru: string; kk?: string | null; en?: string | null };
  intervalKm: number | null;
  intervalMonths: number | null;
  firstKm: number | null;
  firstMonths: number | null;
  serviceCodes: string[];
  target: MaintenanceTarget | null;
  quantity: number | null;
  note: string | null;
  status: "proposed" | "active";
}

function cleanCodes(codes: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const code of codes) {
    const text = code.trim();
    const key = text.toLowerCase();
    if (text && !seen.has(key)) {
      seen.add(key);
      result.push(text);
    }
  }
  return result;
}

/**
 * Maintenance plans kept by the administrator (TASK-061; ARCHITECTURE
 * 4.84): plans of an area and their elements — created, changed with the
 * version, confirmed, reordered, archived, copied to another area. Every
 * change locks the plan's row, writes its entry in the action journal in
 * the same transaction and moves the plan's version (an element's change
 * too: «Подтвердить все» and the order are decided against the plan as
 * read). Titles go through `TranslationQueue.writeTexts` — the Russian text
 * and its automatic translation are one transaction, as in the catalog.
 */
@Injectable()
export class MaintenancePlansService {
  private readonly logger = new Logger("Maintenance");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditLog) private readonly audit: AuditLog,
    @Inject(TranslationQueue) private readonly translations: TranslationQueue,
  ) {}

  // ------------------------------------------------------------- reading

  async list(query: MaintenancePlanListQuery): Promise<AdminMaintenancePlanPage> {
    const executor = this.database.db;
    const limit = query.limit ?? 50;
    const conditions: (SQL | undefined)[] = [
      query.makeId ? eq(maintenancePlan.makeId, query.makeId) : undefined,
      query.modelId ? eq(maintenancePlan.modelId, query.modelId) : undefined,
      query.status ? eq(maintenancePlan.status, query.status) : undefined,
      query.source ? eq(maintenancePlan.source, query.source) : undefined,
      query.q ? this.wordsWhere(query.q) : undefined,
    ];
    const filters = and(...conditions);
    const after = query.cursor ? decodeCursor(query.cursor) : null;
    const [rows, [totals]] = await Promise.all([
      executor
        .select()
        .from(maintenancePlan)
        .where(
          and(
            filters,
            after
              ? sql`(${maintenancePlan.createdAt}, ${maintenancePlan.id}) < (${after.position}::timestamptz, ${after.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(maintenancePlan.createdAt), desc(maintenancePlan.id))
        .limit(limit + 1),
      executor.select({ total: count() }).from(maintenancePlan).where(filters),
    ]);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      plans: await describePlans(executor, page),
      total: totals?.total ?? 0,
      nextCursor:
        rows.length > limit && last
          ? encodeCursor(await this.position(executor, last.id), last.id)
          : null,
    };
  }

  async detail(planId: string): Promise<AdminMaintenancePlanResponse> {
    const executor = this.database.db;
    return planResponse(executor, await this.findPlan(executor, planId));
  }

  /** AI drafts not activated yet — the card of the home screen. */
  async aiDraftsWaiting(): Promise<number> {
    const [row] = await this.database.db
      .select({ total: count() })
      .from(maintenancePlan)
      .where(and(eq(maintenancePlan.status, "draft"), eq(maintenancePlan.source, "ai_draft")));
    return row?.total ?? 0;
  }

  // ------------------------------------------------------------ the plan

  async create(
    body: CreateMaintenancePlanBody,
    actor: MaintenanceActor,
  ): Promise<AdminMaintenancePlanResponse> {
    return this.database.db.transaction(async (tx) => {
      const scope = await resolveScope(tx, body.scope);
      const plan = await this.insertPlan(tx, {
        scope,
        name: body.name ?? null,
        source: "manual",
        actor,
        copiedFromId: null,
      });
      return planResponse(tx, plan);
    });
  }

  /**
   * Writes a new draft of an area with its journal entry (the caller holds
   * the transaction); without a name — the area in words.
   */
  async insertPlan(
    tx: DbExecutor,
    input: {
      scope: MaintenanceScope;
      name: string | null;
      source: MaintenancePlanSource;
      actor: MaintenanceActor;
      copiedFromId: string | null;
      generatingSince?: Date | null;
      aiJobId?: string | null;
      record?: boolean;
    },
  ): Promise<MaintenancePlanRow> {
    const name = input.name ?? scopeText((await describeScopes(tx, [input.scope]))[0]!);
    const [row] = await tx
      .insert(maintenancePlan)
      .values({
        ...input.scope,
        name: name.slice(0, 120),
        source: input.source,
        status: "draft",
        generatingSince: input.generatingSince ?? null,
        aiJobId: input.aiJobId ?? null,
        copiedFromId: input.copiedFromId,
        createdByAdminId: adminOf(input.actor),
      })
      .returning();
    if (input.record !== false) await this.recordCreated(tx, row!, input.actor);
    return row!;
  }

  async recordCreated(
    tx: DbExecutor,
    row: MaintenancePlanRow,
    actor: MaintenanceActor,
  ): Promise<void> {
    await this.audit.record(
      {
        action: auditActions.maintenancePlanCreated,
        actor,
        entityType: auditEntities.maintenancePlan,
        entityId: row.id,
        after: {
          scope: scopeOf(row),
          name: row.name,
          source: row.source,
          ...(row.copiedFromId ? { copiedFromId: row.copiedFromId } : {}),
        },
      },
      tx,
    );
  }

  async update(
    planId: string,
    body: UpdateMaintenancePlanBody,
    actor: MaintenanceActor,
  ): Promise<AdminMaintenancePlanResponse> {
    return this.database.db.transaction(async (tx) => {
      const plan = await this.lockPlan(tx, planId, body.expectedVersion);
      if (plan.generatingSince) throw planState("AI is still making this draft");
      const before = scopeOf(plan);
      const scope = body.scope ? await resolveScope(tx, body.scope) : before;
      const scopeChanged = !sameScope(before, scope);
      if (scopeChanged && plan.status === "active") {
        throw planState("The area of an active plan doesn't change; archive it first");
      }
      const name = body.name ?? plan.name;
      if (!scopeChanged && name === plan.name) return planResponse(tx, plan);
      const updated = await this.bump(tx, plan, { ...scope, name });
      await this.audit.record(
        {
          action: auditActions.maintenancePlanChanged,
          actor,
          entityType: auditEntities.maintenancePlan,
          entityId: plan.id,
          before: {
            ...(scopeChanged ? { scope: before } : {}),
            ...(name !== plan.name ? { name: plan.name } : {}),
          },
          after: {
            ...(scopeChanged ? { scope } : {}),
            ...(name !== plan.name ? { name } : {}),
            version: updated.version,
          },
        },
        tx,
      );
      return planResponse(tx, updated);
    });
  }

  /**
   * `active` — the plan is confirmed: it has elements, every one that is
   * not archived is confirmed and leads to the catalog as it is now, and the
   * area has no other active plan (the unique index decides a race the
   * same way); `archived`; `draft` — back from the archive.
   */
  async setStatus(
    planId: string,
    body: SetMaintenancePlanStatusBody,
    actor: MaintenanceActor,
  ): Promise<AdminMaintenancePlanResponse> {
    try {
      return await this.database.db.transaction(async (tx) => {
        const plan = await this.lockPlan(tx, planId, body.expectedVersion);
        if (plan.status === body.status) return planResponse(tx, plan);
        if (plan.generatingSince) throw planState("AI is still making this draft");
        const now = new Date();
        if (body.status === "active") {
          if (plan.status === "archived") {
            throw planState("Bring an archived plan back as a draft first");
          }
          await this.assertReady(tx, plan);
          const [active] = await tx
            .select({ id: maintenancePlan.id })
            .from(maintenancePlan)
            .where(and(sameScopeWhere(scopeOf(plan)), eq(maintenancePlan.status, "active")));
          if (active) throw activeExists(active.id);
          const updated = await this.bump(tx, plan, {
            status: "active",
            confirmedByAdminId: adminOf(actor),
            confirmedAt: now,
          });
          await this.record(
            tx,
            auditActions.maintenancePlanActivated,
            actor,
            plan,
            updated,
            "draft",
          );
          this.logger.log(`Maintenance plan activated plan=${plan.id}`);
          return planResponse(tx, updated);
        }
        if (body.status === "archived") {
          const updated = await this.bump(tx, plan, { status: "archived", archivedAt: now });
          await this.record(
            tx,
            auditActions.maintenancePlanArchived,
            actor,
            plan,
            updated,
            plan.status,
          );
          return planResponse(tx, updated);
        }
        // `draft`: only from the archive (an active plan is archived, never «un-confirmed»).
        if (plan.status !== "archived") {
          throw planState("Only an archived plan goes back to a draft");
        }
        const updated = await this.bump(tx, plan, {
          status: "draft",
          archivedAt: null,
          confirmedAt: null,
          confirmedByAdminId: null,
        });
        await this.record(
          tx,
          auditActions.maintenancePlanRestored,
          actor,
          plan,
          updated,
          "archived",
        );
        return planResponse(tx, updated);
      });
    } catch (error) {
      if (uniqueViolation(error, ACTIVE_SCOPE_KEY)) {
        const plan = await this.findPlan(this.database.db, planId);
        const [active] = await this.database.db
          .select({ id: maintenancePlan.id })
          .from(maintenancePlan)
          .where(and(sameScopeWhere(scopeOf(plan)), eq(maintenancePlan.status, "active")));
        throw activeExists(active?.id ?? plan.id);
      }
      throw error;
    }
  }

  private async record(
    tx: DbExecutor,
    action: string,
    actor: MaintenanceActor,
    before: MaintenancePlanRow,
    after: MaintenancePlanRow,
    beforeStatus: string,
  ): Promise<void> {
    await this.audit.record(
      {
        action,
        actor,
        entityType: auditEntities.maintenancePlan,
        entityId: before.id,
        before: { status: beforeStatus },
        after: { status: after.status, version: after.version },
      },
      tx,
    );
  }

  /** Why the plan can't be activated now; nothing — it can. */
  async readiness(
    executor: DbExecutor,
    planId: string,
  ): Promise<MaintenanceNotReadyDetails | null> {
    const items = await executor
      .select()
      .from(maintenancePlanItem)
      .where(
        and(eq(maintenancePlanItem.planId, planId), ne(maintenancePlanItem.status, "archived")),
      );
    const targets = await describeTargets(executor, items);
    const problems = items
      .map((item, index) => ({
        itemId: item.id,
        reasons: [
          ...(item.status === "proposed" ? (["not_confirmed"] as const) : []),
          ...targets[index]!.problems,
        ],
      }))
      .filter((entry) => entry.reasons.length > 0);
    if (items.length > 0 && problems.length === 0) return null;
    return { empty: items.length === 0, items: problems };
  }

  private async assertReady(tx: DbExecutor, plan: MaintenancePlanRow): Promise<void> {
    const details = await this.readiness(tx, plan.id);
    if (details) throw notReady(details);
  }

  /**
   * A new manual draft of another area with the same elements that are not
   * archived, confirmed as written (the copy is a person's decision) — for
   * the next generation or another engine. Created whatever the target area
   * has; activating it waits for the active plan there to be archived.
   */
  async copy(
    planId: string,
    body: CopyMaintenancePlanBody,
    actor: MaintenanceActor,
  ): Promise<AdminMaintenancePlanResponse> {
    return this.database.db.transaction(async (tx) => {
      const source = await this.findPlan(tx, planId);
      const scope = await resolveScope(tx, body.scope);
      const plan = await this.insertPlan(tx, {
        scope,
        name: body.name ?? null,
        source: "manual",
        actor,
        copiedFromId: source.id,
      });
      const items = (
        await tx
          .select()
          .from(maintenancePlanItem)
          .where(
            and(
              eq(maintenancePlanItem.planId, source.id),
              ne(maintenancePlanItem.status, "archived"),
            ),
          )
      ).sort(itemOrder);
      const titles = await loadTexts(
        tx,
        "maintenance_plan_item",
        items.map((item) => item.id),
      );
      for (const item of items) {
        const texts = textsOf(titles, item.id, "name");
        const manual = (lang: "kk" | "en") =>
          texts[lang]?.origin === "manual" ? texts[lang]!.text : null;
        await this.insertElement(tx, plan, actor, {
          kind: item.kind,
          title: { ru: texts.ru?.text ?? "Без названия", kk: manual("kk"), en: manual("en") },
          intervalKm: item.intervalKm,
          intervalMonths: item.intervalMonths,
          firstKm: item.firstKm,
          firstMonths: item.firstMonths,
          serviceCodes: item.serviceCodes,
          target: targetOf(item),
          quantity: item.quantity,
          note: item.note,
          // A rule-less proposal stays one: a copy can't confirm what has no rule.
          status: item.status === "proposed" || item.targetKind === null ? "proposed" : "active",
        });
      }
      const updated = await this.findPlan(tx, plan.id);
      return planResponse(tx, updated);
    });
  }

  // ------------------------------------------------------- the elements

  async createItem(
    planId: string,
    body: CreateMaintenanceItemBody,
    actor: MaintenanceActor,
  ): Promise<AdminMaintenancePlanResponse> {
    return this.database.db.transaction(async (tx) => {
      const plan = await this.lockPlan(tx, planId);
      this.assertEditable(plan);
      const element = this.checkedElement({
        kind: body.kind,
        title: body.title,
        intervalKm: body.intervalKm ?? null,
        intervalMonths: body.intervalMonths ?? null,
        firstKm: body.firstKm ?? null,
        firstMonths: body.firstMonths ?? null,
        serviceCodes: body.serviceCodes ?? [],
        target: body.target,
        quantity: body.quantity ?? null,
        note: body.note ?? null,
        status: "active",
      });
      await assertTarget(tx, body.kind, body.target);
      await this.insertElement(tx, plan, actor, element);
      return planResponse(tx, await this.bump(tx, plan, {}));
    });
  }

  /** Writes an element, its title and its journal entry; the caller locked the plan. */
  async insertElement(
    tx: DbExecutor,
    plan: MaintenancePlanRow,
    actor: MaintenanceActor,
    element: NewElement,
  ): Promise<MaintenancePlanItemRow> {
    const [last] = await tx
      .select({ position: sql<number>`coalesce(max(${maintenancePlanItem.position}), -1)` })
      .from(maintenancePlanItem)
      .where(eq(maintenancePlanItem.planId, plan.id));
    const now = new Date();
    const [row] = await tx
      .insert(maintenancePlanItem)
      .values({
        planId: plan.id,
        position: Number(last?.position ?? -1) + 1,
        kind: element.kind,
        intervalKm: element.intervalKm,
        intervalMonths: element.intervalMonths,
        firstKm: element.firstKm,
        firstMonths: element.firstMonths,
        serviceCodes: cleanCodes(element.serviceCodes),
        ...storedTarget(element.kind, element.target),
        quantity: element.quantity,
        note: element.note?.trim() ? element.note.trim().slice(0, 200) : null,
        status: element.status,
        confirmedByAdminId: element.status === "active" ? adminOf(actor) : null,
        confirmedAt: element.status === "active" ? now : null,
      })
      .returning();
    await this.translations.writeTexts(
      tx,
      "maintenance_plan_item",
      row!.id,
      "name",
      {},
      {
        ru: element.title.ru.trim(),
        kk: element.title.kk?.trim() || null,
        en: element.title.en?.trim() || null,
      },
    );
    await this.audit.record(
      {
        action: auditActions.maintenancePlanItemCreated,
        actor,
        entityType: auditEntities.maintenancePlanItem,
        entityId: row!.id,
        after: {
          planId: plan.id,
          title: element.title.ru,
          kind: element.kind,
          intervalKm: element.intervalKm,
          intervalMonths: element.intervalMonths,
          status: element.status,
        },
      },
      tx,
    );
    return row!;
  }

  async updateItem(
    itemId: string,
    body: UpdateMaintenanceItemBody,
    actor: MaintenanceActor,
  ): Promise<AdminMaintenancePlanResponse> {
    const planId = await this.planOf(itemId);
    return this.database.db.transaction(async (tx) => {
      const plan = await this.lockPlan(tx, planId);
      this.assertEditable(plan);
      const item = await this.lockItem(tx, itemId, body.expectedVersion);
      const field = <T>(given: T | undefined, current: T) =>
        given === undefined ? current : given;
      const next = {
        intervalKm: field(body.intervalKm, item.intervalKm),
        intervalMonths: field(body.intervalMonths, item.intervalMonths),
        firstKm: field(body.firstKm, item.firstKm),
        firstMonths: field(body.firstMonths, item.firstMonths),
        serviceCodes: body.serviceCodes ? cleanCodes(body.serviceCodes) : item.serviceCodes,
        quantity: field(body.quantity, item.quantity),
        note: body.note === undefined ? item.note : body.note?.trim() ? body.note.trim() : null,
      };
      this.assertIntervals(next);
      if (body.target) await assertTarget(tx, item.kind, body.target);
      const current = await loadTexts(tx, "maintenance_plan_item", [item.id]);
      const texts = textsOf(current, item.id, "name");
      const before = plainTexts(texts);
      const wantedTitle = {
        ru: body.title?.ru?.trim() ?? before.ru,
        kk: body.title?.kk === undefined ? before.kk : body.title.kk?.trim() || null,
        en: body.title?.en === undefined ? before.en : body.title.en?.trim() || null,
      };
      const titleChanged =
        wantedTitle.ru !== before.ru ||
        wantedTitle.kk !== before.kk ||
        wantedTitle.en !== before.en;
      const targetBefore = targetOf(item);
      const targetChanged =
        body.target !== undefined &&
        JSON.stringify(storedTarget(item.kind, body.target)) !==
          JSON.stringify(storedTarget(item.kind, targetBefore));
      const changes: Record<string, unknown> = {};
      const previous: Record<string, unknown> = {};
      for (const key of Object.keys(next) as (keyof typeof next)[]) {
        if (JSON.stringify(next[key]) !== JSON.stringify(item[key])) {
          changes[key] = next[key];
          previous[key] = item[key];
        }
      }
      if (!titleChanged && !targetChanged && Object.keys(changes).length === 0) {
        return planResponse(tx, plan);
      }
      if (titleChanged) {
        await this.translations.writeTexts(
          tx,
          "maintenance_plan_item",
          item.id,
          "name",
          texts,
          wantedTitle,
        );
      }
      await tx
        .update(maintenancePlanItem)
        .set({
          ...next,
          ...(targetChanged ? storedTarget(item.kind, body.target!) : {}),
          version: item.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(maintenancePlanItem.id, item.id));
      await this.audit.record(
        {
          action: auditActions.maintenancePlanItemChanged,
          actor,
          entityType: auditEntities.maintenancePlanItem,
          entityId: item.id,
          before: {
            ...previous,
            ...(titleChanged ? { title: before } : {}),
            ...(targetChanged ? { target: targetBefore } : {}),
          },
          after: {
            planId: plan.id,
            ...changes,
            ...(titleChanged ? { title: wantedTitle } : {}),
            ...(targetChanged ? { target: body.target } : {}),
            version: item.version + 1,
          },
        },
        tx,
      );
      return planResponse(tx, await this.bump(tx, plan, {}));
    });
  }

  /** `active` — confirm a proposed element (or bring an archived one back); `archived` — «Убрать». */
  async setItemStatus(
    itemId: string,
    body: SetMaintenanceItemStatusBody,
    actor: MaintenanceActor,
  ): Promise<AdminMaintenancePlanResponse> {
    const planId = await this.planOf(itemId);
    return this.database.db.transaction(async (tx) => {
      const plan = await this.lockPlan(tx, planId);
      this.assertEditable(plan);
      const item = await this.lockItem(tx, itemId, body.expectedVersion);
      if (item.status === body.status) return planResponse(tx, plan);
      const now = new Date();
      if (body.status === "active") {
        const target = targetOf(item);
        if (!target)
          throw validationError("target", "The element has no rule yet; give it one first");
        await assertTarget(tx, item.kind, target);
      }
      await tx
        .update(maintenancePlanItem)
        .set(
          body.status === "active"
            ? {
                status: "active",
                archivedAt: null,
                confirmedByAdminId: adminOf(actor),
                confirmedAt: now,
                version: item.version + 1,
                updatedAt: now,
              }
            : { status: "archived", archivedAt: now, version: item.version + 1, updatedAt: now },
        )
        .where(eq(maintenancePlanItem.id, item.id));
      await this.audit.record(
        {
          action:
            body.status === "archived"
              ? auditActions.maintenancePlanItemArchived
              : item.status === "proposed"
                ? auditActions.maintenancePlanItemConfirmed
                : auditActions.maintenancePlanItemRestored,
          actor,
          entityType: auditEntities.maintenancePlanItem,
          entityId: item.id,
          before: { status: item.status },
          after: { planId: plan.id, status: body.status, version: item.version + 1 },
        },
        tx,
      );
      return planResponse(tx, await this.bump(tx, plan, {}));
    });
  }

  /** «Подтвердить все предложенные»: those with a rule that leads to the catalog now. */
  async confirmAll(
    planId: string,
    expectedVersion: number,
    actor: MaintenanceActor,
  ): Promise<ConfirmMaintenanceItemsResponse> {
    return this.database.db.transaction(async (tx) => {
      const plan = await this.lockPlan(tx, planId, expectedVersion);
      this.assertEditable(plan);
      const proposed = await tx
        .select()
        .from(maintenancePlanItem)
        .where(
          and(eq(maintenancePlanItem.planId, plan.id), eq(maintenancePlanItem.status, "proposed")),
        )
        .for("update");
      const targets = await describeTargets(tx, proposed);
      const now = new Date();
      let confirmed = 0;
      for (const [index, item] of proposed.entries()) {
        if (targets[index]!.problems.length > 0) continue;
        await tx
          .update(maintenancePlanItem)
          .set({
            status: "active",
            confirmedByAdminId: adminOf(actor),
            confirmedAt: now,
            version: item.version + 1,
            updatedAt: now,
          })
          .where(eq(maintenancePlanItem.id, item.id));
        await this.audit.record(
          {
            action: auditActions.maintenancePlanItemConfirmed,
            actor,
            entityType: auditEntities.maintenancePlanItem,
            entityId: item.id,
            before: { status: "proposed" },
            after: { planId: plan.id, status: "active", version: item.version + 1 },
          },
          tx,
        );
        confirmed += 1;
      }
      const updated = confirmed > 0 ? await this.bump(tx, plan, {}) : plan;
      return {
        ...(await planResponse(tx, updated)),
        confirmed,
        skipped: proposed.length - confirmed,
      };
    });
  }

  async reorder(
    planId: string,
    body: ReorderMaintenanceItemsBody,
    actor: MaintenanceActor,
  ): Promise<AdminMaintenancePlanResponse> {
    return this.database.db.transaction(async (tx) => {
      const plan = await this.lockPlan(tx, planId);
      this.assertEditable(plan);
      const items = (
        await tx
          .select()
          .from(maintenancePlanItem)
          .where(
            and(
              eq(maintenancePlanItem.planId, plan.id),
              ne(maintenancePlanItem.status, "archived"),
            ),
          )
      ).sort(itemOrder);
      const stored = items.map((item) => item.id);
      if (JSON.stringify(stored) !== JSON.stringify(body.expectedOrder)) {
        throw versionConflict(plan.version);
      }
      if (
        body.itemIds.length !== stored.length ||
        new Set(body.itemIds).size !== stored.length ||
        body.itemIds.some((id) => !stored.includes(id))
      ) {
        throw validationError(
          "itemIds",
          "Give every element of the plan that is not archived, once",
        );
      }
      if (JSON.stringify(stored) === JSON.stringify(body.itemIds)) return planResponse(tx, plan);
      for (const [position, id] of body.itemIds.entries()) {
        await tx
          .update(maintenancePlanItem)
          .set({ position, updatedAt: new Date() })
          .where(eq(maintenancePlanItem.id, id));
      }
      const updated = await this.bump(tx, plan, {});
      await this.audit.record(
        {
          action: auditActions.maintenancePlanItemsReordered,
          actor,
          entityType: auditEntities.maintenancePlan,
          entityId: plan.id,
          before: { itemIds: stored },
          after: { itemIds: body.itemIds, version: updated.version },
        },
        tx,
      );
      return planResponse(tx, updated);
    });
  }

  // ------------------------------------------------------------- helpers

  /** The intervals of an element in order; throws 400 on the field. */
  assertIntervals(element: {
    intervalKm: number | null;
    intervalMonths: number | null;
    firstKm: number | null;
    firstMonths: number | null;
  }): void {
    const problem = maintenanceIntervalsProblem(element);
    if (problem === null) return;
    const where: Record<NonNullable<typeof problem>, [string, string]> = {
      interval_required: ["intervalKm", "Give an interval in km or in months"],
      km_range: ["intervalKm", "Every 1 000…120 000 km"],
      months_range: ["intervalMonths", "Every 1…120 months"],
      first_km: ["firstKm", "The first time must come before the interval in km"],
      first_months: ["firstMonths", "The first time must come before the interval in months"],
    };
    const [path, message] = where[problem];
    throw validationError(path, message);
  }

  checkedElement(element: NewElement): NewElement {
    this.assertIntervals(element);
    return element;
  }

  private assertEditable(plan: MaintenancePlanRow): void {
    if (plan.status === "archived")
      throw planState("The elements of an archived plan don't change");
    if (plan.generatingSince) throw planState("AI is still making this draft");
  }

  private wordsWhere(q: string): SQL {
    const pattern = `%${escapeLike(q.trim())}%`;
    return or(
      sql`${maintenancePlan.name} ILIKE ${pattern} ESCAPE '\\'`,
      sql`EXISTS (SELECT 1 FROM ${vehicleMakeSpelling} WHERE ${vehicleMakeSpelling.makeId} = ${maintenancePlan.makeId} AND ${vehicleMakeSpelling.text} ILIKE ${pattern} ESCAPE '\\')`,
      sql`EXISTS (SELECT 1 FROM ${vehicleModelSpelling} WHERE ${vehicleModelSpelling.modelId} = ${maintenancePlan.modelId} AND ${vehicleModelSpelling.text} ILIKE ${pattern} ESCAPE '\\')`,
      sql`EXISTS (SELECT 1 FROM ${vehicleEngineSpelling} WHERE ${vehicleEngineSpelling.engineId} = ${maintenancePlan.engineId} AND ${vehicleEngineSpelling.text} ILIKE ${pattern} ESCAPE '\\')`,
    )!;
  }

  /** The creation time of a plan at the database's precision (the cursor keeps it). */
  private async position(executor: DbExecutor, planId: string): Promise<string> {
    const result = await executor.execute<{ at: string }>(
      sql`SELECT to_char(${maintenancePlan.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
          FROM ${maintenancePlan} WHERE ${maintenancePlan.id} = ${planId}`,
    );
    return result.rows[0]!.at;
  }

  async findPlan(executor: DbExecutor, planId: string): Promise<MaintenancePlanRow> {
    const [row] = await executor
      .select()
      .from(maintenancePlan)
      .where(eq(maintenancePlan.id, planId));
    if (!row) throw notFound("maintenance plan");
    return row;
  }

  /** The plan's row locked for the change; a stale version — 409. */
  async lockPlan(
    tx: DbExecutor,
    planId: string,
    expectedVersion?: number,
  ): Promise<MaintenancePlanRow> {
    const [row] = await tx
      .select()
      .from(maintenancePlan)
      .where(eq(maintenancePlan.id, planId))
      .for("update");
    if (!row) throw notFound("maintenance plan");
    if (expectedVersion !== undefined && row.version !== expectedVersion) {
      throw versionConflict(row.version);
    }
    return row;
  }

  private async lockItem(
    tx: DbExecutor,
    itemId: string,
    expectedVersion: number,
  ): Promise<MaintenancePlanItemRow> {
    const [row] = await tx
      .select()
      .from(maintenancePlanItem)
      .where(eq(maintenancePlanItem.id, itemId))
      .for("update");
    if (!row) throw notFound("maintenance plan element");
    if (row.version !== expectedVersion) throw versionConflict(row.version);
    return row;
  }

  private async planOf(itemId: string): Promise<string> {
    const [row] = await this.database.db
      .select({ planId: maintenancePlanItem.planId })
      .from(maintenancePlanItem)
      .where(eq(maintenancePlanItem.id, itemId));
    if (!row) throw notFound("maintenance plan element");
    return row.planId;
  }

  /** The plan's next version, with `patch`. */
  async bump(
    tx: DbExecutor,
    plan: MaintenancePlanRow,
    patch: Partial<typeof maintenancePlan.$inferInsert>,
  ): Promise<MaintenancePlanRow> {
    const [row] = await tx
      .update(maintenancePlan)
      .set({ ...patch, version: plan.version + 1, updatedAt: new Date() })
      .where(eq(maintenancePlan.id, plan.id))
      .returning();
    return row!;
  }

  /** Ids of plans, for tests and the seed: the area's plans by status. */
  async plansOf(scope: MaintenanceScope): Promise<MaintenancePlanRow[]> {
    return this.database.db
      .select()
      .from(maintenancePlan)
      .where(sameScopeWhere(scope))
      .orderBy(asc(maintenancePlan.createdAt));
  }

  /** The plans with these ids (in any order). */
  async rows(ids: readonly string[]): Promise<MaintenancePlanRow[]> {
    if (ids.length === 0) return [];
    return this.database.db
      .select()
      .from(maintenancePlan)
      .where(inArray(maintenancePlan.id, [...ids]));
  }
}
