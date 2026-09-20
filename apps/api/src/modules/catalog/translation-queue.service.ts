import { Inject, Injectable, Logger } from "@nestjs/common";
import type { CatalogLanguage, TranslationTargetLanguage } from "@adclub/contracts";
import { and, eq, inArray, sql } from "drizzle-orm";
import { DatabaseService, type DbExecutor } from "../../database";
import { JobQueue } from "../../jobs";
import { AppSettings } from "../settings";
import { SOURCE_LANGUAGE, sourceHash, writeTexts, type StoredTexts } from "./catalog-texts";
import { translateJob } from "./translation-jobs";
import { translationTask, type TranslationEntityType, type TranslationField } from "./schema";

const TARGETS: readonly TranslationTargetLanguage[] = ["kk", "en"];

/**
 * The write side of automatic translation (TASK-012; ARCHITECTURE 4.19):
 * every place that writes the texts of the catalog writes them through
 * here, so a change of a Russian text and the task to translate it are one
 * transaction — no change without its task, no task without its change.
 *
 * What a write asks of translation, per target language:
 * - the Russian text was created or changed, the language has no text or
 *   an automatic one, and it was not written or cleared in the same call →
 *   a task (one per entity, field and language: a second change while the
 *   first is waiting just replaces its hash — the last text is translated);
 * - the language has a manual text → nothing; the text stays and is
 *   flagged as out of date by its hash (it is the administrator's);
 * - the language is written by hand or cleared → no task (a person just
 *   decided it; a queued automatic translation would only undo that).
 */
@Injectable()
export class TranslationQueue {
  private readonly logger = new Logger("Translation");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(JobQueue) private readonly queue: JobQueue,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  /** `writeTexts` (catalog-texts.ts) plus the tasks the write asks for. */
  async writeTexts(
    executor: DbExecutor,
    entityType: TranslationEntityType,
    entityId: string,
    field: TranslationField,
    current: StoredTexts,
    wanted: Record<CatalogLanguage, string | null>,
  ): Promise<void> {
    const result = await writeTexts(executor, entityType, entityId, field, current, wanted);
    const decided = new Set<CatalogLanguage>([...result.written, ...result.removed]);
    const source = wanted[SOURCE_LANGUAGE];
    const stale = [...decided].filter((lang): lang is TranslationTargetLanguage =>
      TARGETS.includes(lang as TranslationTargetLanguage),
    );
    if (stale.length > 0) {
      // A person decided these languages just now: nothing automatic waits for them.
      await this.cancel(executor, entityType, entityId, field, stale);
    }
    if (!result.sourceChanged || source === null) {
      return;
    }
    const wantedLanguages = TARGETS.filter((lang) => {
      if (decided.has(lang)) {
        return false;
      }
      const existing = current[lang];
      return !existing?.isManuallyEdited;
    });
    if (wantedLanguages.length > 0) {
      await this.request(executor, entityType, entityId, field, wantedLanguages, source);
    }
  }

  /**
   * Asks for automatic translation of `source` into `languages` and wakes
   * the worker, in the caller's transaction. A language that already has a
   * task gets the new source hash and a fresh start.
   */
  async request(
    executor: DbExecutor,
    entityType: TranslationEntityType,
    entityId: string,
    field: TranslationField,
    languages: readonly TranslationTargetLanguage[],
    source: string,
  ): Promise<void> {
    if (languages.length === 0) {
      return;
    }
    const hash = sourceHash(source);
    const now = new Date();
    await executor
      .insert(translationTask)
      .values(
        languages.map((lang) => ({
          entityType,
          entityId,
          field,
          lang,
          sourceHash: hash,
        })),
      )
      .onConflictDoUpdate({
        target: [
          translationTask.entityType,
          translationTask.entityId,
          translationTask.field,
          translationTask.lang,
        ],
        set: {
          sourceHash: hash,
          status: "pending",
          failure: null,
          attempts: 0,
          lastError: null,
          updatedAt: now,
        },
      });
    await this.wake(executor);
  }

  /** Withdraws the tasks of these languages (a person wrote the text or released nothing to translate). */
  async cancel(
    executor: DbExecutor,
    entityType: TranslationEntityType,
    entityId: string,
    field: TranslationField,
    languages: readonly TranslationTargetLanguage[],
  ): Promise<void> {
    await executor
      .delete(translationTask)
      .where(
        and(
          eq(translationTask.entityType, entityType),
          eq(translationTask.entityId, entityId),
          eq(translationTask.field, field),
          inArray(translationTask.lang, [...languages]),
        ),
      );
  }

  /**
   * Puts a run of the translation job on the queue, in the caller's
   * transaction (`executor`), with the retries the settings say now.
   */
  async wake(executor?: DbExecutor): Promise<string | null> {
    const [limit, delaySeconds] = await Promise.all([
      this.settings.get("translation_retry_limit"),
      this.settings.get("translation_retry_delay_seconds"),
    ]);
    const id = await this.queue.enqueue(
      translateJob,
      {},
      { ...(executor ? { tx: executor } : {}), retry: { limit, delaySeconds } },
    );
    this.logger.debug(`Translation run put on the queue job=${String(id)}`);
    return id;
  }

  /**
   * Queues every target language that has no text and no task, for every
   * Russian text (operator command; the dev seed): what came before
   * automatic translation, or was cleared by an administrator. Not done by
   * itself — a cleared language would come back — only when asked.
   */
  async queueMissing(): Promise<{ queued: number }> {
    return this.database.db.transaction(async (tx) => {
      const result = await tx.execute<{ id: string }>(sql`
        INSERT INTO translation_task (entity_type, entity_id, field, lang, source_hash)
        SELECT src.entity_type, src.entity_id, src.field, l.lang,
               encode(sha256(convert_to(src.text, 'UTF8')), 'hex')
        FROM translation src
        CROSS JOIN (VALUES ('kk'), ('en')) AS l(lang)
        WHERE src.origin = 'source' AND src.lang = 'ru'
          AND NOT EXISTS (
            SELECT 1 FROM translation t
            WHERE t.entity_type = src.entity_type AND t.entity_id = src.entity_id
              AND t.field = src.field AND t.lang = l.lang)
        ON CONFLICT (entity_type, entity_id, field, lang) DO NOTHING
        RETURNING id`);
      if (result.rows.length > 0) {
        await this.wake(tx);
      }
      return { queued: result.rows.length };
    });
  }

  /** Puts every task refused for good back in the queue (operator command, after the cause is fixed). */
  async retryFailed(): Promise<{ requeued: number }> {
    return this.database.db.transaction(async (tx) => {
      const result = await tx.execute<{ id: string }>(sql`
        UPDATE translation_task
        SET status = 'pending', failure = NULL, attempts = 0, last_error = NULL, updated_at = now()
        WHERE status = 'failed'
        RETURNING id`);
      if (result.rows.length > 0) {
        await this.wake(tx);
      }
      return { requeued: result.rows.length };
    });
  }

  /** For the operator: the queue in numbers, and the tasks refused for good. */
  async status(): Promise<{
    pending: number;
    pendingWithTemporaryFailure: number;
    claimed: number;
    oldestPendingSeconds: number | null;
    failed: {
      entityType: string;
      entityId: string;
      field: string;
      lang: string;
      failure: string;
    }[];
    failedByReason: Record<string, number>;
  }> {
    const counts = await this.database.db.execute<{
      pending: string;
      temporary: string;
      claimed: string;
      oldest: string | null;
    }>(sql`
      SELECT count(*) FILTER (WHERE status = 'pending')::text AS pending,
             count(*) FILTER (WHERE status = 'pending' AND last_error IS NOT NULL)::text AS temporary,
             count(*) FILTER (WHERE status = 'pending' AND claimed_until > now())::text AS claimed,
             extract(epoch FROM now() - min(updated_at) FILTER (WHERE status = 'pending'))::text AS oldest
      FROM translation_task`);
    const failed = await this.database.db
      .select()
      .from(translationTask)
      .where(eq(translationTask.status, "failed"))
      .orderBy(translationTask.updatedAt)
      .limit(50);
    const byReason: Record<string, number> = {};
    for (const row of failed) {
      byReason[row.failure ?? "unknown"] = (byReason[row.failure ?? "unknown"] ?? 0) + 1;
    }
    const row = counts.rows[0];
    return {
      pending: Number(row?.pending ?? 0),
      pendingWithTemporaryFailure: Number(row?.temporary ?? 0),
      claimed: Number(row?.claimed ?? 0),
      oldestPendingSeconds: row?.oldest ? Math.round(Number(row.oldest)) : null,
      failed: failed.map((task) => ({
        entityType: task.entityType,
        entityId: task.entityId,
        field: task.field,
        lang: task.lang,
        failure: task.failure ?? "unknown",
      })),
      failedByReason: byReason,
    };
  }
}
