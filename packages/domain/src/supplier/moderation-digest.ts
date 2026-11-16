/**
 * W-06 «Результаты проверки: добавлено {N}, отклонено {M}» (PRODUCT 12.2;
 * SCREENS 7.3, 8.5; TASK-071; ARCHITECTURE 4.89): what a decision of the
 * administrator counts as in the daily digest of a company, and which
 * decisions the next digest takes.
 *
 * - «добавлено» — a request to add an item that became an item or was
 *   matched to one (`approved`), and a compatibility proposal approved, as
 *   it was or with changes (`approved`, a record created or already there);
 * - «отклонено» — a request or a proposal rejected;
 * - a request still waiting says nothing.
 *
 * A decision is final (from `new` / `pending` only — nothing is taken back
 * or decided again), so each one is counted once: the digest takes the
 * decisions **not yet in a digest** and marks them in the same transaction
 * (`digested_at`). A decision committed while the job runs is not marked —
 * the next digest takes it.
 */
export type ModerationDecisionKind = "item_request" | "compatibility";

export interface ModerationDecision {
  kind: ModerationDecisionKind;
  /** `catalog_request.status` (`new` / `approved` / `rejected`) or `item_compatibility_proposal.status` (`pending` / `approved` / `rejected`). */
  status: string;
  decidedAt: Date | null;
  /** Taken by a digest already; `null` — not yet. */
  digestedAt: Date | null;
}

export function moderationDecisionOutcome(
  decision: Pick<ModerationDecision, "status">,
): "added" | "rejected" | null {
  if (decision.status === "approved") return "added";
  if (decision.status === "rejected") return "rejected";
  return null;
}

/** The next digest takes it: decided and in no digest yet. */
export function inNextDigest(decision: ModerationDecision): boolean {
  return (
    moderationDecisionOutcome(decision) !== null &&
    decision.decidedAt !== null &&
    decision.digestedAt === null
  );
}

export interface ModerationDigestCounts {
  added: number;
  rejected: number;
}

export function moderationDigestCounts(
  decisions: readonly Pick<ModerationDecision, "status">[],
): ModerationDigestCounts {
  const counts: ModerationDigestCounts = { added: 0, rejected: 0 };
  for (const decision of decisions) {
    const outcome = moderationDecisionOutcome(decision);
    if (outcome) counts[outcome] += 1;
  }
  return counts;
}

/** «Не уходит без решений»: 0 and 0 — no message. */
export function moderationDigestDue(counts: ModerationDigestCounts): boolean {
  return counts.added + counts.rejected > 0;
}

/**
 * The key of W-06 for one recipient: one company, one day of Almaty, one
 * employee — a second run of the day (a retry, a second worker, `jobs:run`)
 * queues nothing new.
 */
export function moderationDigestKey(supplierId: string, day: string, memberId: string): string {
  return `moderation_digest:${supplierId}:${day}:${memberId}`;
}

/**
 * Decisions before the first digest after the release: only those of the
 * last day go into it (`ModerationDigest` marks the older ones as taken —
 * the migration does it once).
 */
export const MODERATION_DIGEST_FIRST_LOOKBACK_HOURS = 24;
