import { Inject, Injectable, Logger } from "@nestjs/common";
import { moderationDigestCounts, moderationDigestDue, moderationDigestKey } from "@adclub/domain";
import { sql } from "drizzle-orm";
import { APP_CONFIG, type AppConfig } from "../../config";
import { DatabaseService, type DbExecutor } from "../../database";
import {
  dailyAt,
  definePeriodicJob,
  type JobRunContext,
  type JobRunOutcome,
  type PeriodicJobHandler,
} from "../../jobs";
import { companyRecipients } from "../identity";
import { Messaging } from "../messaging";
import { AppSettings } from "../settings";
import { supplierModerationDigest } from "./schema";

/**
 * `suppliers.moderation-digest` (TASK-071; ARCHITECTURE 13.2, 4.89) —
 * **daily at `moderation_digest_hour`** (Almaty), following the setting while
 * the worker runs: W-06 «Результаты проверки: добавлено {N}, отклонено {M}»
 * to every company with decisions of the administrator not yet in a digest.
 * `operator jobs:run suppliers.moderation-digest` — now.
 */
export const moderationDigestJob = definePeriodicJob({
  name: "suppliers.moderation-digest",
  timeoutSeconds: 900,
  // Tomorrow's run is the retry; what this one did not take stays for it.
  retry: { limit: 0, delaySeconds: 0, backoff: false },
  singleton: true,
  schedule: async (setting) => dailyAt(await setting("moderation_digest_hour")),
});

export const moderationJobCatalog = [moderationDigestJob];

/** The subject of W-06 for the gateway: the digest (nothing to ask before sending). */
export const MODERATION_DIGEST_SUBJECT = "moderation_digest";

/**
 * The digest of each company (PRODUCT 12.2; SCREENS 7.3, W-06).
 *
 * - **What it takes:** the decisions on the company's requests to add an
 *   item and its compatibility proposals not taken by a digest yet
 *   (`digested_at IS NULL`). They are marked in the transaction that queues
 *   the messages — `UPDATE … RETURNING`, so what is counted is exactly what
 *   is marked. A decision committed meanwhile is not marked and waits for
 *   the next digest; a decision is final, so none is counted twice.
 * - **Once a day per company:** `supplier_moderation_digest` has one row per
 *   company and day of Almaty, the company is locked for its digest, and the
 *   message's key is the company, the day and the recipient — a retry, two
 *   workers or a `jobs:run` give no second W-06 that day; the decisions made
 *   after it go into tomorrow's.
 * - **Never empty:** no decision — no message (and nothing is marked).
 * - **To whom:** `companyRecipients` — the contact person (even with the
 *   notices off), else the receivers of notices, else the first three; in
 *   each one's language. A company with no active employee keeps its
 *   decisions for a digest when it has one. A blocked company gets it too:
 *   its cabinet is open and shows the results.
 */
@Injectable()
export class ModerationDigest implements PeriodicJobHandler {
  private readonly logger = new Logger("ModerationDigest");

  // See HttpExceptionFilter (common/errors) for why `@Inject` is required.
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(Messaging) private readonly messaging: Messaging,
    @Inject(AppSettings) private readonly settings: AppSettings,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async run(context: JobRunContext): Promise<JobRunOutcome> {
    const origin = this.config.http.webOrigins.supplierWeb[0];
    if (!origin) {
      this.logger.warn("No cabinet address to put into W-06: no digest today");
      return { worked: false };
    }
    // Read before any transaction (a read inside one would wait for a second connection).
    const notifiedLimit = await this.settings.get("max_notified_members");
    const companies = await this.database.db.execute<{ supplier_id: string }>(sql`
      SELECT supplier_id FROM catalog_request
        WHERE status <> 'new' AND digested_at IS NULL
      UNION
      SELECT supplier_id FROM item_compatibility_proposal
        WHERE status <> 'pending' AND digested_at IS NULL AND supplier_id IS NOT NULL`);
    let sent = 0;
    for (const { supplier_id: supplierId } of companies.rows) {
      if (context.signal.aborted) break;
      try {
        const queued = await this.database.db.transaction((tx) =>
          this.digest(tx, supplierId, `${origin}/moderation`, notifiedLimit),
        );
        if (queued) sent += 1;
      } catch (error) {
        // One company's trouble does not hold the others; tomorrow's run tries it again.
        this.logger.error(
          `Moderation digest failed supplier=${supplierId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    this.logger.log(`Moderation digests queued companies=${String(sent)}`);
    return { worked: sent > 0 };
  }

  /** One company's digest in its transaction; `true` — W-06 is queued. */
  private async digest(
    tx: DbExecutor,
    supplierId: string,
    link: string,
    notifiedLimit: number,
  ): Promise<boolean> {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`moderation-digest:${supplierId}`}))`,
    );
    const [today] = (
      await tx.execute<{ day: string }>(
        sql`SELECT ((now() AT TIME ZONE 'Asia/Almaty')::date)::text AS day`,
      )
    ).rows;
    const day = today!.day;
    const already = await tx.execute(sql`
      SELECT 1 FROM supplier_moderation_digest WHERE supplier_id = ${supplierId} AND day = ${day}::date`);
    if (already.rows.length > 0) return false;
    const recipients = await companyRecipients(tx, supplierId, notifiedLimit);
    if (recipients.length === 0) return false;
    const marked = await tx.execute<{ status: string }>(sql`
      WITH requests AS (
        UPDATE catalog_request SET digested_at = now()
        WHERE supplier_id = ${supplierId} AND status <> 'new' AND digested_at IS NULL
        RETURNING status
      ), proposals AS (
        UPDATE item_compatibility_proposal SET digested_at = now()
        WHERE supplier_id = ${supplierId} AND status <> 'pending' AND digested_at IS NULL
        RETURNING status
      )
      SELECT status FROM requests UNION ALL SELECT status FROM proposals`);
    const counts = moderationDigestCounts(marked.rows);
    if (!moderationDigestDue(counts)) return false;
    const [digest] = await tx
      .insert(supplierModerationDigest)
      .values({ supplierId, day, ...counts, recipients: recipients.length })
      .returning({ id: supplierModerationDigest.id });
    for (const recipient of recipients) {
      await this.messaging.enqueue(tx, {
        template: "moderation_digest",
        phone: recipient.phone,
        lang: recipient.lang,
        variables: { added: String(counts.added), rejected: String(counts.rejected), link },
        subject: { type: MODERATION_DIGEST_SUBJECT, id: digest!.id },
        dedupeKey: moderationDigestKey(supplierId, day, recipient.memberId),
      });
    }
    return true;
  }
}
