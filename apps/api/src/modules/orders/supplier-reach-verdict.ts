/**
 * Whether the notices of orders can reach a company at all (D-061; TASK-034,
 * ARCHITECTURE 4.52) — the pure rule of the detector `supplier-reach.ts`.
 *
 * There is no other channel to a supplier than WhatsApp (D-061), so a
 * company every recipient of which has no WhatsApp hears of no order. What
 * we know about a number is the last decisive word about a message to it:
 * delivered (or, with the test channel, sent — it delivers nothing) — the
 * number is on WhatsApp; refused as `no_whatsapp` — it is not. Other
 * failures (the provider down, a rejected template) say nothing about the
 * number and are left to the outage of the channel (TASK-025).
 */

/** The last decisive word about one recipient's number; `null` — none yet. */
export interface RecipientReach {
  memberId: string;
  last: { kind: "delivered" | "no_whatsapp"; at: Date } | null;
}

export interface SupplierReachVerdict {
  /** Every recipient (at least one) has no WhatsApp by the last word about the number. */
  unreachable: boolean;
  /** How many recipients have no WhatsApp. */
  withoutWhatsapp: number;
  /** The earliest and the latest refusal among them (`since`, `lastFailureAt`). */
  firstFailureAt: Date | null;
  lastFailureAt: Date | null;
  /** The latest delivery to any recipient: a message reached the company. */
  reachedAt: Date | null;
}

export function supplierReachVerdict(recipients: readonly RecipientReach[]): SupplierReachVerdict {
  const failures = recipients.flatMap((recipient) =>
    recipient.last?.kind === "no_whatsapp" ? [recipient.last.at.getTime()] : [],
  );
  const deliveries = recipients.flatMap((recipient) =>
    recipient.last?.kind === "delivered" ? [recipient.last.at.getTime()] : [],
  );
  return {
    unreachable: recipients.length > 0 && failures.length === recipients.length,
    withoutWhatsapp: failures.length,
    firstFailureAt: failures.length > 0 ? new Date(Math.min(...failures)) : null,
    lastFailureAt: failures.length > 0 ? new Date(Math.max(...failures)) : null,
    reachedAt: deliveries.length > 0 ? new Date(Math.max(...deliveries)) : null,
  };
}
