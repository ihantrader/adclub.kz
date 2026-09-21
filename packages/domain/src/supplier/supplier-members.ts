/**
 * Who of a company's employees receives the notifications about orders
 * (PRODUCT 12.6; ARCHITECTURE 4.27): the employees with the switch on,
 * but no more than the limit (the setting `max_notified_members`). The
 * earliest to turn the switch on come first (then the earliest added);
 * when the limit is lowered below the number of switched-on employees,
 * no switch is turned off — the latest ones stop receiving until someone
 * turns theirs off or the limit is raised. Turning the switch on is only
 * allowed while fewer than the limit have it on, so the rule decides only
 * after a lowered limit.
 */
export interface NotificationCandidate {
  id: string;
  /** When the switch was turned on; `null` — off. */
  notificationsEnabledAt: Date | null;
  createdAt: Date;
}

export interface NotificationRecipients {
  /** Ids of the employees who receive. */
  recipients: ReadonlySet<string>;
  limit: number;
  /** Employees with the switch on. */
  enabled: number;
  /** No one else may turn the switch on now. */
  full: boolean;
}

/** `candidates` — the active employees of one company. */
export function notificationRecipients(
  candidates: readonly NotificationCandidate[],
  limit: number,
): NotificationRecipients {
  const enabled = candidates
    .filter((candidate) => candidate.notificationsEnabledAt !== null)
    .sort(
      (a, b) =>
        a.notificationsEnabledAt!.getTime() - b.notificationsEnabledAt!.getTime() ||
        a.createdAt.getTime() - b.createdAt.getTime() ||
        a.id.localeCompare(b.id),
    );
  const recipients = new Set(enabled.slice(0, Math.max(0, limit)).map((candidate) => candidate.id));
  return { recipients, limit, enabled: enabled.length, full: enabled.length >= limit };
}

/** Whether one more employee may turn the switch on. */
export function canEnableNotifications(enabled: number, limit: number): boolean {
  return enabled < limit;
}
