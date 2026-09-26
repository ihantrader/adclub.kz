/**
 * Whether the channel of notices to suppliers is failing (TASK-025
 * requirement 4; PRODUCT 10.4; ARCHITECTURE 6.6) — pure functions over the
 * notices of orders as the detector judged them, so the rule is a unit test.
 *
 * A notice is judged at one moment and one way:
 *
 * - **failed** — refused for good (`failed`), lost on the way with nobody
 *   knowing whether it went (`unknown`, ARCHITECTURE 4.35 I358 — the
 *   decision of TASK-024 that such a notice must reach this detector), or not
 *   delivered in time: still queued or being sent, or sent by the real
 *   channel without a report of delivery, `whatsapp_outage_delivery_timeout_minutes`
 *   after it was queued or sent;
 * - **delivered** — reported delivered or read (the test channel reports
 *   nothing, so for it «sent» is as far as a notice gets and counts as
 *   delivered);
 * - neither yet — too young to say; not counted.
 */

export interface JudgedNotice {
  orderId: string | null;
  supplierId: string | null;
  /**
   * When it was queued — in the transaction of its event, so for a notice
   * of a new order the moment the order was created. An outage «began» with
   * the first failed notice queued (A-ORD-03 lists the orders from there).
   */
  queuedAt: Date;
  /** When it was judged failed; `null` — it is not failed. */
  failedAt: Date | null;
  /** When it was judged delivered; `null` — it is not delivered. */
  deliveredAt: Date | null;
  failureKind: string | null;
}

export interface OutageThresholds {
  /** At least this many failed notices… */
  minFailures: number;
  /** …being at least this share of the judged ones. */
  ratio: number;
}

export interface WindowCount {
  failed: number;
  judged: number;
  /** When the earliest of the failed notices in the window was queued. */
  firstQueuedAt: Date | null;
}

/** The notices judged inside `[from, …)`: how many failed, of how many. */
export function countWindow(notices: readonly JudgedNotice[], from: Date): WindowCount {
  let failed = 0;
  let delivered = 0;
  let firstQueuedAt: Date | null = null;
  for (const notice of notices) {
    if (notice.failedAt && notice.failedAt >= from) {
      failed += 1;
      if (!firstQueuedAt || notice.queuedAt < firstQueuedAt) {
        firstQueuedAt = notice.queuedAt;
      }
    } else if (notice.deliveredAt && notice.deliveredAt >= from) {
      delivered += 1;
    }
  }
  return { failed, judged: failed + delivered, firstQueuedAt };
}

/**
 * Where the window of judgement starts: `windowMinutes` back from now — but
 * never at or before the last failure a closed signal already told about, so
 * an outage that is over is not told again. The bound is that failure's own
 * time, not the moment the signal was closed: a failure is stamped by the
 * clock of the worker that settled it, a close by the clock of the database,
 * and the two may disagree by more than the gap between the last failure and
 * the delivery that closed the signal (it happened: a second signal opened
 * from the failures of the first).
 */
export function windowStart(
  now: Date,
  windowMinutes: number,
  lastClosed: { lastFailureAt: Date | null; closedAt: Date | null } | null,
): Date {
  const start = new Date(now.getTime() - windowMinutes * 60_000);
  const told = lastClosed?.lastFailureAt ?? lastClosed?.closedAt ?? null;
  if (told && told.getTime() + 1 > start.getTime()) {
    return new Date(told.getTime() + 1);
  }
  return start;
}

/** Whether a window's count is an outage by the thresholds. */
export function isOutage(count: WindowCount, thresholds: OutageThresholds): boolean {
  return (
    count.failed >= thresholds.minFailures &&
    count.judged > 0 &&
    count.failed / count.judged >= thresholds.ratio
  );
}

export interface OutageSummary {
  failedMessages: number;
  affectedOrders: number;
  /** At most `maxSuppliers` of them, in the order they first failed. */
  supplierIds: string[];
  failureKinds: Record<string, number>;
  lastFailedAt: Date | null;
}

/**
 * What failed since the outage began (notices queued from `since` on that
 * failed): how many, of which orders and suppliers, and how.
 */
export function summarizeSince(
  notices: readonly JudgedNotice[],
  since: Date,
  maxSuppliers = 50,
): OutageSummary {
  const failed = notices
    .filter((notice) => notice.failedAt && notice.queuedAt >= since)
    .sort((a, b) => a.failedAt!.getTime() - b.failedAt!.getTime());
  const orders = new Set<string>();
  const suppliers: string[] = [];
  const kinds: Record<string, number> = {};
  for (const notice of failed) {
    if (notice.orderId) {
      orders.add(notice.orderId);
    }
    if (notice.supplierId && !suppliers.includes(notice.supplierId)) {
      suppliers.push(notice.supplierId);
    }
    const kind = notice.failureKind ?? "not_delivered";
    kinds[kind] = (kinds[kind] ?? 0) + 1;
  }
  return {
    failedMessages: failed.length,
    affectedOrders: orders.size,
    supplierIds: suppliers.slice(0, maxSuppliers),
    failureKinds: kinds,
    lastFailedAt: failed.at(-1)?.failedAt ?? null,
  };
}

/**
 * When the channel delivered again: the first notice delivered after the
 * last failure. `null` — it has not (and silence is not a recovery: with no
 * notice at all nobody knows the channel works).
 */
export function recoveredAt(notices: readonly JudgedNotice[], lastFailedAt: Date): Date | null {
  let first: Date | null = null;
  for (const notice of notices) {
    if (notice.deliveredAt && notice.deliveredAt > lastFailedAt) {
      if (!first || notice.deliveredAt < first) {
        first = notice.deliveredAt;
      }
    }
  }
  return first;
}
