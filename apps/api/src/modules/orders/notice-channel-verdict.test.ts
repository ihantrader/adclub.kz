import { describe, expect, it } from "vitest";
import {
  countWindow,
  isOutage,
  recoveredAt,
  summarizeSince,
  windowStart,
  type JudgedNotice,
} from "./notice-channel-verdict";

const at = (minute: number) => new Date(Date.UTC(2026, 8, 26, 10, minute));

/** Queued a minute before it was judged failed. */
function failed(
  minute: number,
  order = "o1",
  supplier = "s1",
  kind: string | null = null,
): JudgedNotice {
  return {
    orderId: order,
    supplierId: supplier,
    queuedAt: at(minute - 1),
    failedAt: at(minute),
    deliveredAt: null,
    failureKind: kind,
  };
}

function delivered(minute: number): JudgedNotice {
  return {
    orderId: "ok",
    supplierId: "s9",
    queuedAt: at(minute),
    failedAt: null,
    deliveredAt: at(minute),
    failureKind: null,
  };
}

describe("the detector of an outage of the notice channel (TASK-025)", () => {
  const thresholds = { minFailures: 3, ratio: 0.5 };

  it("counts only what was judged inside the window", () => {
    const notices = [failed(1), failed(12), failed(13), delivered(14), delivered(2)];
    // The outage began when the first of its failed notices was queued.
    expect(countWindow(notices, at(10))).toEqual({ failed: 2, judged: 3, firstQueuedAt: at(11) });
  });

  it("is an outage only with enough failures that are a large enough share", () => {
    expect(isOutage({ failed: 2, judged: 2, firstQueuedAt: at(1) }, thresholds)).toBe(false);
    expect(isOutage({ failed: 3, judged: 7, firstQueuedAt: at(1) }, thresholds)).toBe(false);
    expect(isOutage({ failed: 3, judged: 6, firstQueuedAt: at(1) }, thresholds)).toBe(true);
    expect(isOutage({ failed: 3, judged: 3, firstQueuedAt: at(1) }, thresholds)).toBe(true);
    expect(
      isOutage({ failed: 0, judged: 0, firstQueuedAt: null }, { minFailures: 1, ratio: 0.01 }),
    ).toBe(false);
  });

  it("sums up what failed since the outage began: notices, orders, suppliers, kinds", () => {
    const notices = [
      failed(1, "o0", "s0"),
      failed(5, "o1", "s1", "unavailable"),
      failed(6, "o1", "s1", "unavailable"),
      failed(7, "o2", "s2", "unknown"),
      failed(8, "o3", "s1"),
      delivered(9),
    ];
    // Queued from minute 4 on: the failure of minute 5 is the first counted.
    expect(summarizeSince(notices, at(4))).toEqual({
      failedMessages: 4,
      affectedOrders: 3,
      supplierIds: ["s1", "s2"],
      failureKinds: { unavailable: 2, unknown: 1, not_delivered: 1 },
      lastFailedAt: at(8),
    });
    expect(summarizeSince(notices, at(4), 1).supplierIds).toEqual(["s1"]);
  });

  it("starts the window after the last failure a closed signal told about — whatever the clock of the close", () => {
    const now = at(30);
    expect(windowStart(now, 15, null)).toEqual(at(15));
    // A long-ago signal does not narrow the window.
    expect(windowStart(now, 15, { lastFailureAt: at(2), closedAt: at(3) })).toEqual(at(15));
    // A recent one: counting starts just after its last failure…
    const after = windowStart(now, 15, { lastFailureAt: at(20), closedAt: at(21) });
    expect(after.getTime()).toBe(at(20).getTime() + 1);
    // …even when the close was stamped by a clock behind the worker's, earlier
    // than the failure itself: that failure must not open a second signal.
    const skewed = windowStart(now, 15, { lastFailureAt: at(20), closedAt: at(19) });
    expect(countWindow([failed(20), failed(20)], skewed).failed).toBe(0);
    expect(windowStart(now, 15, { lastFailureAt: null, closedAt: at(21) })).toEqual(
      new Date(at(21).getTime() + 1),
    );
  });

  it("recovers at the first delivery after the last failure — and not by silence", () => {
    expect(recoveredAt([failed(5), delivered(3)], at(5))).toBeNull();
    expect(recoveredAt([failed(5), delivered(9), delivered(7)], at(5))).toEqual(at(7));
    expect(recoveredAt([], at(5))).toBeNull();
  });
});
