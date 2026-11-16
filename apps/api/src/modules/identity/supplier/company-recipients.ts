import { and, asc, eq } from "drizzle-orm";
import type { DbExecutor } from "../../../database";
import { account, supplierMember } from "../schema";

/** A person of a company a service message of the club goes to. */
export interface CompanyRecipient {
  memberId: string;
  phone: string;
  lang: "kk" | "ru";
}

/** How many employees hear of it when nobody is the contact person and nobody takes notices. */
const FALLBACK_RECIPIENTS = 3;

/**
 * **Who hears of a service message of the club about the company itself**
 * — its money (W-05, W-05a — TASK-042) and the results of moderation (W-06 —
 * TASK-071): the company's contact person (even with the notices of orders
 * off — the message is about the company, not an order); if there is none,
 * the employees who receive the notices of orders, the earliest
 * `notifiedLimit` by the moment they switched them on; if there are none
 * either, the first three employees. Never nobody while the company has an
 * active employee. Each in the language of their notices.
 */
export async function companyRecipients(
  executor: DbExecutor,
  supplierId: string,
  notifiedLimit: number,
): Promise<CompanyRecipient[]> {
  const rows = await executor
    .select({
      memberId: supplierMember.id,
      phone: account.phone,
      lang: supplierMember.notificationLanguage,
      contact: supplierMember.isContactPerson,
      enabledAt: supplierMember.notificationsEnabledAt,
    })
    .from(supplierMember)
    .innerJoin(account, eq(account.id, supplierMember.accountId))
    .where(and(eq(supplierMember.supplierId, supplierId), eq(supplierMember.status, "active")))
    .orderBy(asc(supplierMember.createdAt), asc(supplierMember.id));
  let chosen = rows.filter((row) => row.contact);
  if (chosen.length === 0) {
    chosen = rows
      .filter((row) => row.enabledAt !== null)
      .sort((a, b) => a.enabledAt!.getTime() - b.enabledAt!.getTime())
      .slice(0, notifiedLimit);
  }
  if (chosen.length === 0) {
    chosen = rows.slice(0, FALLBACK_RECIPIENTS);
  }
  return chosen.map((row) => ({ memberId: row.memberId, phone: row.phone, lang: row.lang }));
}
