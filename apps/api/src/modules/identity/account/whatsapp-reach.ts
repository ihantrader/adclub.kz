import { sql, type SQL } from "drizzle-orm";
import type { DbExecutor } from "../../../database";

/** The last decisive word about a number: on WhatsApp or not, and since when. */
export interface WhatsappWord {
  kind: "whatsapp" | "no_whatsapp";
  /** What said so: the channel of the confirmed login code, or a message's outcome. */
  source: "login_code" | "message";
  at: Date;
}

/**
 * Whether a number is on WhatsApp by the last decisive word about it: nothing
 * known yet — it is, as far as anyone knows.
 */
export function whatsappAvailable(word: WhatsappWord | null): boolean {
  return word?.kind !== "no_whatsapp";
}

/**
 * «No WhatsApp» of a user (TASK-052 requirement 3; PRODUCT 15; ARCHITECTURE
 * 9.3, 4.80) is not a flag anybody sets: it is the last decisive word about
 * the person's number among what is already written down —
 *
 * - `phone_verification.channel` (ARCHITECTURE 4.5): the last login code was
 *   confirmed by SMS — no; through WhatsApp — yes;
 * - `outbound_message`: a message to the number refused `no_whatsapp` — no;
 *   delivered or read (with the test channel — sent: it delivers nothing) —
 *   yes. The same words the detector «поставщик недостижим» reads
 *   (`supplier-reach.ts`).
 *
 * So a mark is set and lifted by the facts themselves, with no second path
 * to keep in step, and every reader — the fallback, the profile, the admin
 * panel, the metrics — reads this one SQL.
 */

function wordsOf(phone: SQL): SQL {
  return sql`
    SELECT CASE WHEN pv.channel = 'sms' THEN 'no_whatsapp' ELSE 'whatsapp' END AS kind,
           'login_code' AS source, pv.verified_at AS at
    FROM phone_verification pv WHERE pv.phone = ${phone}
    UNION ALL
    SELECT CASE WHEN m.status = 'failed' THEN 'no_whatsapp' ELSE 'whatsapp' END AS kind,
           'message' AS source,
           CASE
             WHEN m.status IN ('delivered', 'read') THEN coalesce(m.delivered_at, m.read_at, m.settled_at)
             WHEN m.status = 'sent' THEN m.sent_at
             ELSE coalesce(m.settled_at, m.updated_at)
           END AS at
    FROM outbound_message m
    WHERE m.phone = ${phone}
      AND (
        m.status IN ('delivered', 'read')
        OR (m.status = 'sent' AND m.provider = 'test')
        OR (m.status = 'failed' AND m.failure_kind = 'no_whatsapp')
      )`;
}

/** The kind of the last decisive word about a number (an SQL expression; `NULL` — none). */
export function lastWhatsappWordKind(phone: SQL): SQL<string | null> {
  return sql<string | null>`(SELECT w.kind FROM (${wordsOf(phone)}) w
    WHERE w.at IS NOT NULL ORDER BY w.at DESC LIMIT 1)`;
}

/** A condition: the number has no WhatsApp by the last decisive word (A-USR-01 «нет WhatsApp»). */
export function noWhatsappCondition(phone: SQL): SQL {
  return sql`${lastWhatsappWordKind(phone)} = 'no_whatsapp'`;
}

function dateOf(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

/** The last decisive word about one number; `null` — nothing decisive yet. */
export async function whatsappWordOf(
  executor: DbExecutor,
  phone: string,
): Promise<WhatsappWord | null> {
  const result = await executor.execute<{ kind: string; source: string; at: unknown }>(sql`
    SELECT w.kind, w.source, w.at FROM (${wordsOf(sql`${phone}`)}) w
    WHERE w.at IS NOT NULL ORDER BY w.at DESC LIMIT 1
  `);
  const row = result.rows[0];
  if (!row) return null;
  return {
    kind: row.kind === "no_whatsapp" ? "no_whatsapp" : "whatsapp",
    source: row.source === "login_code" ? "login_code" : "message",
    at: dateOf(row.at),
  };
}

/** How many users have no WhatsApp now (metrics, `push:status`). */
export async function countWithoutWhatsapp(executor: DbExecutor): Promise<number> {
  const result = await executor.execute<{ count: string }>(sql`
    SELECT count(*)::text AS count FROM account a
    WHERE (
      EXISTS (SELECT 1 FROM phone_verification pv WHERE pv.phone = a.phone AND pv.channel = 'sms')
      OR EXISTS (SELECT 1 FROM outbound_message m WHERE m.phone = a.phone
        AND m.status = 'failed' AND m.failure_kind = 'no_whatsapp')
    )
    AND ${noWhatsappCondition(sql`a.phone`)}
  `);
  return Number(result.rows[0]?.count ?? 0);
}
