import { Inject, Injectable, Logger, Module, type OnModuleInit } from "@nestjs/common";
import type {
  CatalogLanguage,
  TranslationFailure,
  TranslationTargetLanguage,
} from "@adclub/contracts";
import { and, eq, sql } from "drizzle-orm";
import { describeError } from "../../common/health";
import { DatabaseService, withoutQueryParameters, type DbExecutor } from "../../database";
import {
  JobRegistry,
  PermanentJobError,
  type JobHandler,
  type JobRunContext,
  type JobRunOutcome,
  type PeriodicJobHandler,
} from "../../jobs";
import {
  AiBudgetExhaustedError,
  AiGatewayError,
  AiService,
  type AiInitiator,
  type TranslateItem,
  type TranslateOutput,
} from "../ai";
import { Metrics } from "../../observability";
import { AppSettings } from "../settings";
import { nameScopeLock, STRUCTURE_LOCK_SHARED } from "./catalog-locks";
import { findNameClash, nameNeighbours } from "./catalog-names";
import { SOURCE_LANGUAGE, sourceHash } from "./catalog-texts";
import { checkTranslation, maxLengthOf } from "./translation-checks";
import { PhotoFileDeletion, PhotoOrphanCleanup } from "./photo-cleanup";
import { photoFileDeletionJob, photoOrphanCleanupJob } from "./photo-jobs";
import { PhotoStorage } from "./photo-storage";
import { translateJob, translationWakeJob } from "./translation-jobs";
import { TranslationQueue } from "./translation-queue.service";
import {
  translation,
  translationTask,
  type TranslationEntityType,
  type TranslationField,
} from "./schema";

/** A run that has been going this long stops taking batches and hands the rest to a new run. */
const MAX_RUN_MS = 150_000;
/** A task a run has claimed stays its own this long; then another run may take it (a run that died). */
const LEASE_SECONDS = 300;

const CONTEXTS: Record<string, string> = {
  "category:name": "the name of a product category in an automotive parts and services catalog",
  "attribute:name": "the name of a characteristic (attribute) of automotive products",
  "attribute:unit":
    "the unit of measure of a characteristic of automotive products (an abbreviation)",
  "attribute_option:name": "one option of a list characteristic of automotive products",
  "catalog_item:name": "the name of a catalog item: an automotive spare part, a fluid or a service",
};

interface ClaimedTask {
  id: string;
  entityType: TranslationEntityType;
  entityId: string;
  field: TranslationField;
  lang: TranslationTargetLanguage;
  /** The administrator who asked for this translation; `null` — nobody in particular. */
  requestedBy: string | null;
}

/** One text of a batch: what is translated, and the tasks that ask for it. */
interface BatchItem {
  id: string;
  entityType: TranslationEntityType;
  entityId: string;
  field: TranslationField;
  source: string;
  hash: string;
  tasks: ClaimedTask[];
}

export type SaveOutcome = "saved" | "failed" | "skipped" | "superseded" | "incomplete";

/**
 * The translation job (TASK-012; ARCHITECTURE 4.19): claims pending tasks
 * in batches, asks `AiService` and saves what passes the checks. Safe to
 * repeat and to run in several workers at once: a task is claimed with a
 * lease (`FOR UPDATE SKIP LOCKED`), and saving re-reads everything under
 * the catalog lock — the Russian text is still the one translated, the
 * language has no manual text, the name is free — so a change, a manual
 * edit or a second run in between can only make the save a no-op.
 */
@Injectable()
export class TranslationRunner implements JobHandler<Record<string, never>> {
  private readonly logger = new Logger("Translation");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(AiService) private readonly ai: AiService,
    @Inject(TranslationQueue) private readonly queue: TranslationQueue,
  ) {}

  async run(_payload: Record<string, never>, context: JobRunContext): Promise<void> {
    const startedAt = Date.now();
    const totals = {
      saved: 0,
      failed: 0,
      skipped: 0,
      superseded: 0,
      incomplete: 0,
      batches: 0,
    };
    let stopped = false;
    while (!stopped) {
      if (context.signal.aborted) {
        return;
      }
      if (Date.now() - startedAt >= MAX_RUN_MS) {
        this.logger.log("Translation run out of time, a new run takes the rest");
        await this.queue.wake();
        break;
      }
      const batchSize = await this.settings.get("translation_batch_size");
      const claimed = await this.claim(batchSize);
      if (claimed.length === 0) {
        break;
      }
      // One call per initiator: a call asked for by an administrator is
      // recorded as theirs, not as the system's (TASK-053 requirement 4).
      for (const group of byInitiator(claimed)) {
        const outcome = await this.translateBatch(group.tasks, group.initiator);
        if (outcome === "budget") {
          stopped = true;
          break;
        }
        totals.batches += 1;
        for (const [key, count] of Object.entries(outcome)) {
          totals[key as SaveOutcome] += count;
        }
        if (outcome.incomplete > 0) {
          // The texts left out are pending again and could be claimed by this
          // very run: asking the same provider again straight away would be a
          // tight loop of paid calls. The run stops here, and the retries of
          // the job, with their pause, decide when to ask again.
          stopped = true;
          break;
        }
      }
    }
    if (totals.batches > 0) {
      this.logger.log(
        `Translation run finished batches=${totals.batches} saved=${totals.saved} failed=${totals.failed} skipped=${totals.skipped} superseded=${totals.superseded} incomplete=${totals.incomplete} durationMs=${Date.now() - startedAt}`,
      );
    }
    if (totals.incomplete > 0) {
      // The provider answered, but not about everything it was asked. That is
      // a trouble of the moment, not a verdict on those texts: the missing
      // ones stay pending and this job is retried by its own rules
      // (`translation_retry_limit`, `translation_retry_delay_seconds`), which
      // ask for them again. The dead letter queue is where it ends if the
      // provider keeps leaving them out — visible, unlike a false "empty".
      throw new Error(
        `The AI provider answered about ${totals.saved + totals.failed} texts and left ${totals.incomplete} of them out; the missing ones are asked again`,
      );
    }
  }

  /** The oldest pending tasks no run holds, now held by this one. */
  private async claim(limit: number): Promise<ClaimedTask[]> {
    const result = await this.database.db.execute<{
      id: string;
      entity_type: TranslationEntityType;
      entity_id: string;
      field: TranslationField;
      lang: TranslationTargetLanguage;
      requested_by: string | null;
    }>(sql`
      UPDATE translation_task SET claimed_until = now() + make_interval(secs => ${LEASE_SECONDS})
      WHERE id IN (
        SELECT id FROM translation_task
        WHERE status = 'pending' AND (claimed_until IS NULL OR claimed_until < now())
        ORDER BY updated_at, id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, entity_type, entity_id, field, lang, requested_by`);
    return result.rows.map((row) => ({
      id: row.id,
      entityType: row.entity_type,
      entityId: row.entity_id,
      field: row.field,
      lang: row.lang,
      requestedBy: row.requested_by,
    }));
  }

  private async translateBatch(
    claimed: ClaimedTask[],
    initiator: AiInitiator,
  ): Promise<Record<SaveOutcome, number> | "budget"> {
    const counts: Record<SaveOutcome, number> = {
      saved: 0,
      failed: 0,
      skipped: 0,
      superseded: 0,
      incomplete: 0,
    };
    const items = await this.itemsOf(claimed, counts);
    if (items.length === 0) {
      return counts;
    }
    const languages = [...new Set(items.flatMap((item) => item.tasks.map((task) => task.lang)))];
    let output: TranslateOutput;
    let jobId: string;
    let model: string;
    try {
      const request: TranslateItem[] = items.map((item) => ({
        id: item.id,
        text: item.source,
        context: CONTEXTS[`${item.entityType}:${item.field}`] ?? "a name in an automotive catalog",
        maxLength: maxLengthOf(item.entityType, item.field),
        languages: item.tasks.map((task) => task.lang),
      }));
      const result = await this.ai.translate(
        { items: request },
        {
          initiator,
          inputRef: { tasks: claimed.length, items: items.length, languages },
        },
      );
      ({ output, jobId, model } = result);
    } catch (error) {
      await this.release(
        claimed.map((task) => task.id),
        error instanceof AiGatewayError ? error.kind : undefined,
      );
      if (error instanceof AiBudgetExhaustedError) {
        this.logger.warn(
          `Translation stopped: the daily AI budget is spent ($${error.spentUsd} of $${error.budgetUsd}); pending tasks wait for a new day or a raised budget`,
        );
        return "budget";
      }
      if (error instanceof AiGatewayError && error.kind === "rejected") {
        throw new PermanentJobError(error.message, { cause: error });
      }
      throw error;
    }

    const texts = new Map(
      output.translations.map((entry) => [`${entry.id}:${entry.lang}`, entry.text]),
    );
    const missing: string[] = [];
    for (const item of items) {
      for (const task of item.tasks) {
        const text = texts.get(`${item.id}:${task.lang}`);
        if (text === undefined) {
          // The provider said nothing about this one: ask again later
          // (TASK-053 requirement 4), never "the translation was empty".
          missing.push(task.id);
          counts.incomplete += 1;
          continue;
        }
        let outcome: SaveOutcome;
        try {
          outcome = await this.save(task, item, text, { jobId, model });
        } catch (error) {
          // One task failing to save (a lock timeout, a deadlock) must not lose the others:
          // its lease is released and a later run tries it again.
          this.logger.warn(
            `Translation not saved task=${task.id} error=${describeError(withoutQueryParameters(error))}`,
          );
          await this.release([task.id], undefined);
          outcome = "skipped";
        }
        counts[outcome] += 1;
      }
    }
    if (missing.length > 0) {
      this.logger.warn(
        `The AI answer left ${missing.length} of ${missing.length + counts.saved + counts.failed} texts out; they stay pending and are asked again job=${jobId} model=${model}`,
      );
      await this.release(missing, "incomplete_answer");
    }
    return counts;
  }

  /**
   * The batch's items: one per (entity, field) with the Russian text as it
   * is now. A task whose Russian text is gone (the entity or field no
   * longer exists) is dropped.
   */
  private async itemsOf(
    claimed: ClaimedTask[],
    counts: Record<SaveOutcome, number>,
  ): Promise<BatchItem[]> {
    const items = new Map<string, BatchItem>();
    for (const task of claimed) {
      const key = `${task.entityType}:${task.entityId}:${task.field}`;
      const known = items.get(key);
      if (known) {
        known.tasks.push(task);
        continue;
      }
      const [source] = await this.database.db
        .select({ text: translation.text })
        .from(translation)
        .where(
          and(
            eq(translation.entityType, task.entityType),
            eq(translation.entityId, task.entityId),
            eq(translation.field, task.field),
            eq(translation.lang, SOURCE_LANGUAGE),
          ),
        );
      if (!source) {
        await this.database.db.delete(translationTask).where(eq(translationTask.id, task.id));
        counts.skipped += 1;
        continue;
      }
      items.set(key, {
        id: String(items.size),
        entityType: task.entityType,
        entityId: task.entityId,
        field: task.field,
        source: source.text,
        hash: sourceHash(source.text),
        tasks: [task],
      });
    }
    return [...items.values()];
  }

  /**
   * Saves one translation, or decides it can't be saved — in one
   * transaction, on what is true now, holding the structure of the catalog
   * against change (shared, like every write of an item) and the names of
   * this entity's neighbours against another writer (ARCHITECTURE 4.20
   * I191). Translations of different neighbourhoods, and the
   * administrator's work on items, no longer wait for each other.
   */
  async save(
    task: ClaimedTask,
    item: BatchItem,
    text: string | undefined,
    call: { jobId: string; model: string },
  ): Promise<SaveOutcome> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(STRUCTURE_LOCK_SHARED);
      const scope = task.field === "name" ? await this.nameScope(tx, task) : null;
      if (scope) {
        await tx.execute(nameScopeLock(scope));
      }
      const [row] = await tx
        .select()
        .from(translationTask)
        .where(eq(translationTask.id, task.id))
        .for("update");
      if (!row || row.status !== "pending") {
        return "skipped";
      }
      const [source] = await tx
        .select({ text: translation.text })
        .from(translation)
        .where(
          and(
            eq(translation.entityType, task.entityType),
            eq(translation.entityId, task.entityId),
            eq(translation.field, task.field),
            eq(translation.lang, SOURCE_LANGUAGE),
          ),
        );
      if (!source) {
        await tx.delete(translationTask).where(eq(translationTask.id, task.id));
        return "skipped";
      }
      if (sourceHash(source.text) !== item.hash) {
        // The Russian text changed while this was translated: the new text has its own
        // (re-armed) task; this answer is for the old one.
        await tx
          .update(translationTask)
          .set({ claimedUntil: null })
          .where(eq(translationTask.id, task.id));
        return "superseded";
      }
      const [existing] = await tx
        .select()
        .from(translation)
        .where(
          and(
            eq(translation.entityType, task.entityType),
            eq(translation.entityId, task.entityId),
            eq(translation.field, task.field),
            eq(translation.lang, task.lang),
          ),
        );
      if (existing?.isManuallyEdited) {
        // Written by hand meanwhile: never overwritten.
        await tx.delete(translationTask).where(eq(translationTask.id, task.id));
        return "skipped";
      }

      const checked =
        text === undefined
          ? ({ ok: false, failure: "empty" } as const)
          : checkTranslation(
              text,
              task.lang,
              item.source,
              maxLengthOf(task.entityType, task.field),
            );
      if (!checked.ok) {
        return this.refuse(tx, task, checked.failure);
      }
      if (task.field === "name") {
        const clash = await this.clash(tx, task, checked.text);
        if (clash) {
          return this.refuse(tx, task, "name_taken");
        }
      }
      const values = {
        text: checked.text,
        origin: "ai" as const,
        isManuallyEdited: false,
        sourceHash: item.hash,
        aiModel: call.model,
        aiJobId: call.jobId,
        updatedAt: new Date(),
      };
      if (existing) {
        await tx.update(translation).set(values).where(eq(translation.id, existing.id));
      } else {
        await tx.insert(translation).values({
          entityType: task.entityType,
          entityId: task.entityId,
          field: task.field,
          lang: task.lang,
          ...values,
        });
      }
      await tx.delete(translationTask).where(eq(translationTask.id, task.id));
      return "saved";
    });
  }

  /** What set of names this entity's name belongs to; `null` — it has no neighbours. */
  private async nameScope(tx: DbExecutor, task: ClaimedTask): Promise<string | null> {
    const info = await nameNeighbours(tx, task.entityType, task.entityId);
    return info?.scope ?? null;
  }

  /** Whether a neighbour already has this name in this language (archived entities aren't checked, 4.15 I144). */
  private async clash(tx: DbExecutor, task: ClaimedTask, text: string): Promise<boolean> {
    const info = await nameNeighbours(tx, task.entityType, task.entityId);
    if (!info || info.status === "archived") {
      return false;
    }
    const names: Record<CatalogLanguage, string | null> = { kk: null, ru: null, en: null };
    names[task.lang] = text;
    const found = await findNameClash(tx, task.entityType, info.neighbours, names, task.entityId);
    return found !== undefined;
  }

  private async refuse(
    tx: DbExecutor,
    task: ClaimedTask,
    failure: TranslationFailure,
  ): Promise<SaveOutcome> {
    await tx
      .update(translationTask)
      .set({ status: "failed", failure, claimedUntil: null, updatedAt: new Date() })
      .where(eq(translationTask.id, task.id));
    this.logger.warn(
      `Translation refused, not saved (not tried again until the source changes or an administrator asks) task=${task.id} entity=${task.entityType}/${task.entityId} field=${task.field} lang=${task.lang} reason=${failure}`,
    );
    return "failed";
  }

  /** Gives tasks back; a failed call counts against them (`attempts`, `last_error`). */
  private async release(ids: string[], errorKind: string | undefined): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    try {
      await this.database.db.execute(sql`
        UPDATE translation_task
        SET claimed_until = NULL,
            attempts = attempts + ${errorKind === undefined ? 0 : 1},
            last_error = COALESCE(${errorKind ?? null}, last_error)
        WHERE id IN (${sql.join(
          ids.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`);
    } catch (error) {
      // The leases expire by themselves.
      this.logger.warn(
        `Translation tasks not released: ${describeError(withoutQueryParameters(error))}`,
      );
    }
  }
}

/**
 * The claimed tasks split by who asked for them, so every AI call is
 * recorded with its real initiator (TASK-053 requirement 4): the
 * administrator who pressed "translate again" or released a manual text,
 * or the system — a change of a Russian text, an operator command, the
 * safety net. Tasks of one administrator stay one call.
 */
function byInitiator(claimed: ClaimedTask[]): { initiator: AiInitiator; tasks: ClaimedTask[] }[] {
  const groups = new Map<string, ClaimedTask[]>();
  for (const task of claimed) {
    const key = task.requestedBy ?? "";
    const known = groups.get(key);
    if (known) {
      known.push(task);
    } else {
      groups.set(key, [task]);
    }
  }
  return [...groups].map(([key, tasks]) => ({
    initiator: key === "" ? { type: "system" } : { type: "account", id: key },
    tasks,
  }));
}

/**
 * The safety net (`translationWakeJob`): pending tasks that have waited a
 * while, that nobody holds and whose last run did not fail for a
 * temporary reason get a run — unless the day's AI budget is spent.
 */
@Injectable()
export class TranslationWake implements PeriodicJobHandler {
  private readonly logger = new Logger("Translation");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AiService) private readonly ai: AiService,
    @Inject(TranslationQueue) private readonly queue: TranslationQueue,
  ) {}

  async run(): Promise<JobRunOutcome> {
    const result = await this.database.db.execute<{ waiting: string }>(sql`
      SELECT count(*)::text AS waiting FROM translation_task
      WHERE status = 'pending' AND last_error IS NULL
        AND (claimed_until IS NULL OR claimed_until < now())
        AND updated_at < now() - interval '2 minutes'`);
    const waiting = Number(result.rows[0]?.waiting ?? 0);
    if (waiting === 0) {
      return { worked: false };
    }
    if ((await this.ai.budget()).exhausted) {
      return { worked: false };
    }
    await this.queue.wake();
    this.logger.log(`Translation run started by the safety net waiting=${waiting}`);
    return { worked: true };
  }
}

/**
 * The translation queue as metrics, sampled from `translation_task` when
 * metrics are scraped: how many wait, how many were refused for good.
 */
@Injectable()
export class TranslationMetrics implements OnModuleInit {
  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(Metrics) private readonly metrics: Metrics,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  onModuleInit(): void {
    this.metrics.collectTranslation(async () => {
      const result = await this.database.db.execute<{ status: string; tasks: string }>(
        sql`SELECT status, count(*)::text AS tasks FROM translation_task GROUP BY status`,
      );
      const counts = new Map(result.rows.map((row) => [row.status, Number(row.tasks)]));
      for (const state of ["pending", "failed"]) {
        this.metrics.setTranslationTasks(state, counts.get(state) ?? 0);
      }
    });
  }
}

/** The catalog's background jobs, for the worker process. */
@Module({
  providers: [
    TranslationQueue,
    TranslationRunner,
    TranslationWake,
    PhotoStorage,
    PhotoFileDeletion,
    PhotoOrphanCleanup,
  ],
})
export class CatalogJobsModule implements OnModuleInit {
  constructor(
    @Inject(JobRegistry) private readonly registry: JobRegistry,
    @Inject(TranslationRunner) private readonly runner: TranslationRunner,
    @Inject(TranslationWake) private readonly wake: TranslationWake,
    @Inject(PhotoFileDeletion) private readonly photoFiles: PhotoFileDeletion,
    @Inject(PhotoOrphanCleanup) private readonly photoOrphans: PhotoOrphanCleanup,
  ) {}

  onModuleInit(): void {
    this.registry.handle(translateJob, this.runner);
    this.registry.handlePeriodic(translationWakeJob, this.wake);
    this.registry.sweep(photoFileDeletionJob, this.photoFiles);
    this.registry.handlePeriodic(photoOrphanCleanupJob, this.photoOrphans);
  }
}
