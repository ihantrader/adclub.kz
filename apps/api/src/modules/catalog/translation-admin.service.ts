import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  auditActions,
  auditEntities,
  catalogNameText,
  translationEntityTypeSchema,
  translationFieldSchema,
  translationTargetLanguageSchema,
  type EntityTranslationsResponse,
  type TranslationEntityType,
  type TranslationField,
  type TranslationLanguage,
  type TranslationQueuePage,
  type TranslationQueueQuery,
  type TranslationQueueState,
  type TranslationTargetLanguage,
} from "@adclub/contracts";
import { and, eq, sql } from "drizzle-orm";
import { ApiException } from "../../common/errors";
import { DatabaseService, type DbExecutor } from "../../database";
import { AuditLog } from "../audit";
import type { CatalogActor } from "./catalog-admin.service";
import { nameTaken, notFound, validationError } from "./catalog-errors";
import { STRUCTURE_LOCK } from "./catalog-locks";
import { findNameClash, nameNeighbours } from "./catalog-names";
import { SOURCE_LANGUAGE, normalizeText, sourceHash } from "./catalog-texts";
import { maxLengthOf } from "./translation-checks";
import { TranslationQueue } from "./translation-queue.service";
import { translation, translationTask, type TranslationRow } from "./schema";

const FIELDS: readonly TranslationField[] = ["name", "unit"];

function iso(date: Date): string {
  return date.toISOString();
}

/**
 * Translations for the administrator (TASK-012; SCREENS A-CAT-05 tab
 * "Переводы"; ARCHITECTURE 4.19): what each language of each field holds and
 * where it came from, writing one by hand, giving one back to automatic
 * translation, asking for one again, and the list of what still waits.
 * Every change is one transaction under the catalog lock with its entry in
 * the action journal.
 */
/**
 * The account behind an administrator's action, or `null` for the server
 * operator command, which has no account (D-045). The translation task
 * remembers it so the AI call made for it is recorded as that
 * administrator's, not as the system's (TASK-053 requirement 4).
 */
function accountOf(actor: CatalogActor): string | null {
  return actor.role === "admin" ? actor.accountId : null;
}

@Injectable()
export class TranslationAdminService {
  private readonly logger = new Logger("Translation");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditLog) private readonly audit: AuditLog,
    @Inject(TranslationQueue) private readonly queue: TranslationQueue,
  ) {}

  // ---------------------------------------------------------------- reads

  async get(
    entityType: TranslationEntityType,
    entityId: string,
    executor: DbExecutor = this.database.db,
  ): Promise<EntityTranslationsResponse> {
    if (!(await nameNeighbours(executor, entityType, entityId))) {
      throw notFound("entity");
    }
    const rows = await executor
      .select()
      .from(translation)
      .where(and(eq(translation.entityType, entityType), eq(translation.entityId, entityId)));
    const tasks = await executor
      .select()
      .from(translationTask)
      .where(
        and(eq(translationTask.entityType, entityType), eq(translationTask.entityId, entityId)),
      );
    const fields: EntityTranslationsResponse["fields"] = [];
    for (const field of FIELDS) {
      const source = rows.find((row) => row.field === field && row.lang === SOURCE_LANGUAGE);
      if (!source) {
        continue;
      }
      const hash = sourceHash(source.text);
      const languageOf = (lang: "kk" | "ru" | "en"): TranslationLanguage => {
        const row = rows.find((candidate) => candidate.field === field && candidate.lang === lang);
        const task = tasks.find(
          (candidate) => candidate.field === field && candidate.lang === lang,
        );
        return {
          translation: row ? this.describe(row, hash) : null,
          task: task
            ? {
                state: task.status === "failed" ? "failed" : "queued",
                failure: task.failure,
                attempts: task.attempts,
                updatedAt: iso(task.updatedAt),
              }
            : null,
        };
      };
      fields.push({
        field,
        texts: { kk: languageOf("kk"), ru: languageOf("ru"), en: languageOf("en") },
      });
    }
    return { entityType, entityId, fields };
  }

  private describe(row: TranslationRow, currentHash: string) {
    return {
      text: row.text,
      origin: row.origin,
      isManuallyEdited: row.isManuallyEdited,
      isSourceChanged: row.origin !== "source" && row.sourceHash !== currentHash,
      aiModel: row.origin === "ai" ? row.aiModel : null,
      updatedAt: iso(row.updatedAt),
    };
  }

  // -------------------------------------------------------------- changes

  /**
   * A translation written by hand: checked like any name (length, no
   * control characters, free among neighbours), stored as manual against
   * the Russian text as it is now — which also clears "the source changed"
   * for a text the administrator looked at and kept — and any automatic
   * translation waiting for the language is withdrawn.
   */
  async edit(
    entityType: TranslationEntityType,
    entityId: string,
    field: TranslationField,
    lang: TranslationTargetLanguage,
    rawText: string,
    actor: CatalogActor,
  ): Promise<EntityTranslationsResponse> {
    const max = this.maxLength(entityType, field);
    const parsed = catalogNameText(max).safeParse(rawText);
    if (!parsed.success) {
      throw validationError("text", parsed.error.issues[0]?.message ?? "Invalid text");
    }
    const text = normalizeText(parsed.data);
    return this.database.db.transaction(async (tx) => {
      await tx.execute(STRUCTURE_LOCK);
      const source = await this.sourceOf(tx, entityType, entityId, field);
      const info = await nameNeighbours(tx, entityType, entityId);
      if (!info) {
        throw notFound("entity");
      }
      const hash = sourceHash(source);
      const existing = await this.rowOf(tx, entityType, entityId, field, lang);
      const unchanged =
        existing?.text === text && existing.isManuallyEdited && existing.sourceHash === hash;
      if (!unchanged) {
        if (field === "name" && info.status !== "archived") {
          const clash = await findNameClash(
            tx,
            entityType,
            info.neighbours,
            { kk: null, ru: null, en: null, [lang]: text },
            entityId,
          );
          if (clash) {
            throw nameTaken(clash.lang, clash.id);
          }
        }
        const values = {
          text,
          origin: "manual" as const,
          isManuallyEdited: true,
          sourceHash: hash,
          aiModel: null,
          aiJobId: null,
          updatedAt: new Date(),
        };
        if (existing) {
          await tx.update(translation).set(values).where(eq(translation.id, existing.id));
        } else {
          await tx.insert(translation).values({ entityType, entityId, field, lang, ...values });
        }
        await this.audit.record(
          {
            action: auditActions.catalogTranslationEdited,
            actor,
            entityType: auditEntities.catalogTranslation,
            entityId,
            before: existing
              ? { entityType, field, lang, text: existing.text, origin: existing.origin }
              : null,
            after: { entityType, field, lang, text, origin: "manual" },
          },
          tx,
        );
        this.logger.log(
          `Translation edited by hand entity=${entityType}/${entityId} field=${field} lang=${lang}`,
        );
      }
      await this.queue.cancel(tx, entityType, entityId, field, [lang]);
      return this.get(entityType, entityId, tx);
    });
  }

  /**
   * Gives a manual translation back to automatic translation: the text
   * stays where it is (clients keep seeing it) until the new translation
   * replaces it, and the language is queued.
   */
  async release(
    entityType: TranslationEntityType,
    entityId: string,
    field: TranslationField,
    lang: TranslationTargetLanguage,
    actor: CatalogActor,
  ): Promise<EntityTranslationsResponse> {
    this.maxLength(entityType, field);
    return this.database.db.transaction(async (tx) => {
      await tx.execute(STRUCTURE_LOCK);
      const source = await this.sourceOf(tx, entityType, entityId, field);
      const existing = await this.rowOf(tx, entityType, entityId, field, lang);
      if (!existing) {
        throw notFound("translation");
      }
      if (!existing.isManuallyEdited) {
        throw new ApiException(
          409,
          "TRANSLATION_NOT_MANUAL",
          "This text is not a manual edit: there is nothing to release",
        );
      }
      await tx
        .update(translation)
        .set({
          origin: "ai",
          isManuallyEdited: false,
          aiModel: null,
          aiJobId: null,
          updatedAt: new Date(),
        })
        .where(eq(translation.id, existing.id));
      await this.queue.request(tx, entityType, entityId, field, [lang], source, accountOf(actor));
      await this.audit.record(
        {
          action: auditActions.catalogTranslationReleased,
          actor,
          entityType: auditEntities.catalogTranslation,
          entityId,
          before: { entityType, field, lang, origin: "manual" },
          after: { entityType, field, lang, origin: "ai" },
        },
        tx,
      );
      this.logger.log(
        `Manual translation released entity=${entityType}/${entityId} field=${field} lang=${lang}`,
      );
      return this.get(entityType, entityId, tx);
    });
  }

  /**
   * "Translate again": for an automatic text, a missing one or one that
   * was refused before; a text written by hand is never touched
   * (`TRANSLATION_MANUALLY_EDITED`). Idempotent: a language already
   * waiting stays one task.
   */
  async retranslate(
    entityType: TranslationEntityType,
    entityId: string,
    field: TranslationField,
    lang: TranslationTargetLanguage,
    actor: CatalogActor,
  ): Promise<EntityTranslationsResponse> {
    this.maxLength(entityType, field);
    return this.database.db.transaction(async (tx) => {
      await tx.execute(STRUCTURE_LOCK);
      const source = await this.sourceOf(tx, entityType, entityId, field);
      const existing = await this.rowOf(tx, entityType, entityId, field, lang);
      if (existing?.isManuallyEdited) {
        throw new ApiException(
          409,
          "TRANSLATION_MANUALLY_EDITED",
          "This text was written by hand and is never overwritten by automatic translation; release the manual edit first",
        );
      }
      await this.queue.request(tx, entityType, entityId, field, [lang], source, accountOf(actor));
      await this.audit.record(
        {
          action: auditActions.catalogTranslationRequeued,
          actor,
          entityType: auditEntities.catalogTranslation,
          entityId,
          after: { entityType, field, lang },
        },
        tx,
      );
      this.logger.log(
        `Translation requested again entity=${entityType}/${entityId} field=${field} lang=${lang}`,
      );
      return this.get(entityType, entityId, tx);
    });
  }

  // ---------------------------------------------------------------- queue

  /** What waits for a translation or is out of date, with the volume by state. */
  async queueList(query: TranslationQueueQuery): Promise<TranslationQueuePage> {
    const filters = [
      query.entityType ? sql`AND src.entity_type = ${query.entityType}` : sql``,
      query.lang ? sql`AND l.lang = ${query.lang}` : sql``,
    ];
    // Pairs of (Russian text, target language), what each one holds now and its task.
    const classified = sql`
      WITH pairs AS (
        SELECT src.entity_type, src.entity_id, src.field, l.lang, src.text AS source_text,
               encode(sha256(convert_to(src.text, 'UTF8')), 'hex') AS source_hash
        FROM translation src
        CROSS JOIN (VALUES ('kk'), ('en')) AS l(lang)
        WHERE src.origin = 'source' AND src.lang = 'ru' ${sql.join(filters, sql` `)}
      ), classified AS (
        SELECT p.entity_type, p.entity_id, p.field, p.lang, p.source_text,
               t.text AS current_text, t.origin AS current_origin,
               (t.id IS NOT NULL AND t.source_hash IS DISTINCT FROM p.source_hash) AS is_source_changed,
               k.failure AS failure,
               CASE WHEN k.status = 'failed' THEN 'failed'
                    WHEN k.status = 'pending' THEN 'queued'
                    WHEN t.id IS NULL THEN 'missing'
                    WHEN t.source_hash IS DISTINCT FROM p.source_hash THEN 'outdated'
               END AS state
        FROM pairs p
        LEFT JOIN translation t ON t.entity_type = p.entity_type AND t.entity_id = p.entity_id
          AND t.field = p.field AND t.lang = p.lang
        LEFT JOIN translation_task k ON k.entity_type = p.entity_type AND k.entity_id = p.entity_id
          AND k.field = p.field AND k.lang = p.lang
      )`;
    const stateFilter = query.state ? sql`AND state = ${query.state}` : sql``;
    const position = query.cursor ? this.parseCursor(query.cursor) : undefined;
    const after = position
      ? sql`AND (entity_type, entity_id, field, lang) > (${position.entityType}, ${position.entityId}::uuid, ${position.field}, ${position.lang})`
      : sql``;

    const counts = await this.database.db.execute<{ state: TranslationQueueState; n: string }>(
      sql`${classified} SELECT state, count(*)::text AS n FROM classified WHERE state IS NOT NULL GROUP BY state`,
    );
    const total = await this.database.db.execute<{ n: string }>(
      sql`${classified} SELECT count(*)::text AS n FROM classified WHERE state IS NOT NULL ${stateFilter}`,
    );
    const page = await this.database.db.execute<{
      entity_type: TranslationEntityType;
      entity_id: string;
      field: TranslationField;
      lang: TranslationTargetLanguage;
      state: TranslationQueueState;
      source_text: string;
      current_text: string | null;
      current_origin: "source" | "ai" | "manual" | null;
      is_source_changed: boolean;
      failure: TranslationQueuePage["items"][number]["failure"];
    }>(sql`${classified}
      SELECT * FROM classified WHERE state IS NOT NULL ${stateFilter} ${after}
      ORDER BY entity_type, entity_id, field, lang
      LIMIT ${query.limit + 1}`);

    const rows = page.rows.slice(0, query.limit);
    const last = rows.at(-1);
    const byState = new Map(counts.rows.map((row) => [row.state, Number(row.n)]));
    return {
      items: rows.map((row) => ({
        entityType: row.entity_type,
        entityId: row.entity_id,
        field: row.field,
        lang: row.lang,
        state: row.state,
        sourceText: row.source_text,
        currentText: row.current_text,
        currentOrigin: row.current_origin,
        isSourceChanged: row.is_source_changed,
        failure: row.failure,
      })),
      total: Number(total.rows[0]?.n ?? 0),
      counts: {
        missing: byState.get("missing") ?? 0,
        queued: byState.get("queued") ?? 0,
        failed: byState.get("failed") ?? 0,
        outdated: byState.get("outdated") ?? 0,
      },
      nextCursor:
        page.rows.length > query.limit && last
          ? Buffer.from(
              `${last.entity_type}|${last.entity_id}|${last.field}|${last.lang}`,
              "utf8",
            ).toString("base64url")
          : null,
    };
  }

  private parseCursor(cursor: string): {
    entityType: TranslationEntityType;
    entityId: string;
    field: TranslationField;
    lang: TranslationTargetLanguage;
  } {
    const [entityType, entityId, field, lang] = Buffer.from(cursor, "base64url")
      .toString("utf8")
      .split("|");
    const type = translationEntityTypeSchema.safeParse(entityType);
    const fieldChecked = translationFieldSchema.safeParse(field);
    const langChecked = translationTargetLanguageSchema.safeParse(lang);
    if (
      !type.success ||
      !fieldChecked.success ||
      !langChecked.success ||
      !entityId ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entityId)
    ) {
      throw validationError("cursor", "Not a cursor of this list");
    }
    return {
      entityType: type.data,
      entityId,
      field: fieldChecked.data,
      lang: langChecked.data,
    };
  }

  // -------------------------------------------------------------- helpers

  /** The longest text of the field; a field the entity doesn't have is a validation error. */
  private maxLength(entityType: TranslationEntityType, field: TranslationField): number {
    try {
      return maxLengthOf(entityType, field);
    } catch {
      throw validationError("field", `A ${entityType} has no translatable "${field}"`);
    }
  }

  private async sourceOf(
    tx: DbExecutor,
    entityType: TranslationEntityType,
    entityId: string,
    field: TranslationField,
  ): Promise<string> {
    const source = await this.rowOf(tx, entityType, entityId, field, SOURCE_LANGUAGE);
    if (!source) {
      throw notFound("text to translate");
    }
    return source.text;
  }

  private async rowOf(
    tx: DbExecutor,
    entityType: TranslationEntityType,
    entityId: string,
    field: TranslationField,
    lang: "kk" | "ru" | "en",
  ): Promise<TranslationRow | undefined> {
    const [row] = await tx
      .select()
      .from(translation)
      .where(
        and(
          eq(translation.entityType, entityType),
          eq(translation.entityId, entityId),
          eq(translation.field, field),
          eq(translation.lang, lang),
        ),
      );
    return row;
  }
}
