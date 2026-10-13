import { eq } from "drizzle-orm";
import type { DbExecutor } from "../../database";
import { supplierMember } from "../identity";

/**
 * Up to when an employee has seen «Модерация» (S-MOD-01, TASK-048;
 * ARCHITECTURE 4.68): the moment they last opened it, or — never opened —
 * the moment they joined the company, so a new colleague doesn't find the
 * company's whole past marked «новое». A decision made after it is «новое».
 */
export async function moderationSeenAt(executor: DbExecutor, memberId: string): Promise<Date> {
  const [row] = await executor
    .select({ seenAt: supplierMember.moderationSeenAt, createdAt: supplierMember.createdAt })
    .from(supplierMember)
    .where(eq(supplierMember.id, memberId));
  return row?.seenAt ?? row?.createdAt ?? new Date(0);
}
