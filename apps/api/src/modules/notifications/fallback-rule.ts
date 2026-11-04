import type { NotificationStatus } from "./schema";

/**
 * Whether a push to the user is copied to WhatsApp (TASK-052 requirement 1;
 * ARCHITECTURE 9.3 level 3, 4.80) — the one rule, pure, so its table of
 * cases is a unit test (`fallback-rule.test.ts`). The sweeper
 * `notifications.fallback` and `Notifications.enqueue` (a push that has
 * nowhere to go, a recipient whose push is unreliable) both ask it and do
 * what it says; nothing else decides a fallback.
 */

/** Why a push gets no copy (kept on the push: `notification.fallback_decision`). */
export type FallbackSkipReason =
  /** The kind is not in `critical_notification_kinds` now. */
  | "not_critical"
  /** The app confirmed it. */
  | "acked"
  /** A later notification about the same subject took its place: only the latest is told. */
  | "superseded"
  /** The subject moved on without a push of its own (an order cancelled, a reserve past its time). */
  | "not_current"
  /** The event is older than `push_fallback_max_age_hours` (the worker stood still). */
  | "stale"
  /** The person has no WhatsApp: the event stays in the app (PRODUCT 15). */
  | "no_whatsapp"
  /** More than `push_fallback_per_account_day` copies to this person within a day. */
  | "rate_limited";

/** Why a copy goes. */
export type FallbackCause =
  /** Sent (or its outcome unknown, or still on its way) and not confirmed in time. */
  | "timeout"
  /** The person had no device for push. */
  | "no_device"
  /** Every device refused for good. */
  | "failed"
  /** The session ended before it was sent: as no device. */
  | "cancelled"
  /** The person's push is unreliable: at once, not waiting for the timeout. */
  | "unreliable";

export type FallbackDecision =
  | { kind: "wait"; until: Date }
  | { kind: "send"; cause: FallbackCause }
  /** `timedOut` — the push was not confirmed in time (counts towards `push_unreliable`). */
  | { kind: "skip"; reason: FallbackSkipReason; timedOut: boolean };

export interface FallbackInput {
  /** The kind is in `critical_notification_kinds` now. */
  critical: boolean;
  status: NotificationStatus;
  createdAt: Date;
  sentAt: Date | null;
  ackedAt: Date | null;
  /** A later push of a critical kind about the same subject to the same person exists. */
  superseded: boolean;
  /** The owning module says the event still holds (`NotificationSubjects`). */
  current: boolean;
  /** The person's critical pushes went unconfirmed `push_unreliable_after` times in a row. */
  unreliable: boolean;
  /** The last decisive word about the person's number says it is on WhatsApp (or nothing is known). */
  whatsapp: boolean;
  /** Copies already sent to this person within the last day. */
  fallbacksToday: number;
  now: Date;
  timeoutMinutes: number;
  maxAgeHours: number;
  perAccountDay: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * The moment a push not confirmed counts as «not confirmed in time»: from
 * when it was sent; a push still on its way, or one whose outcome is
 * unknown without a send time, from when it was queued.
 */
export function fallbackDueAt(
  input: Pick<FallbackInput, "status" | "createdAt" | "sentAt" | "timeoutMinutes">,
): Date {
  const from =
    input.status === "sent" || input.status === "unknown"
      ? (input.sentAt ?? input.createdAt)
      : input.createdAt;
  return new Date(from.getTime() + input.timeoutMinutes * MINUTE);
}

export function fallbackDecision(input: FallbackInput): FallbackDecision {
  if (!input.critical) return { kind: "skip", reason: "not_critical", timedOut: false };
  if (input.ackedAt) return { kind: "skip", reason: "acked", timedOut: false };
  if (input.superseded) return { kind: "skip", reason: "superseded", timedOut: false };
  if (!input.current) return { kind: "skip", reason: "not_current", timedOut: false };
  if (input.now.getTime() - input.createdAt.getTime() > input.maxAgeHours * HOUR) {
    return { kind: "skip", reason: "stale", timedOut: false };
  }
  let cause: FallbackCause;
  if (input.status === "no_device") cause = "no_device";
  else if (input.status === "cancelled") cause = "cancelled";
  else if (input.status === "failed") cause = "failed";
  else if (input.unreliable) cause = "unreliable";
  else {
    const due = fallbackDueAt(input);
    if (input.now.getTime() < due.getTime()) return { kind: "wait", until: due };
    cause = "timeout";
  }
  const timedOut = cause === "timeout";
  if (!input.whatsapp) return { kind: "skip", reason: "no_whatsapp", timedOut };
  if (input.fallbacksToday >= input.perAccountDay) {
    return { kind: "skip", reason: "rate_limited", timedOut };
  }
  return { kind: "send", cause };
}
