import { describe, expect, it } from "vitest";
import {
  fallbackDecision,
  fallbackDueAt,
  type FallbackDecision,
  type FallbackInput,
} from "./fallback-rule";
import { whatsappAvailable } from "../identity";

const NOW = new Date("2026-11-04T10:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

function input(overrides: Partial<FallbackInput>): FallbackInput {
  return {
    critical: true,
    status: "sent",
    createdAt: minutesAgo(12),
    sentAt: minutesAgo(11),
    ackedAt: null,
    superseded: false,
    current: true,
    unreliable: false,
    whatsapp: true,
    fallbacksToday: 0,
    now: NOW,
    timeoutMinutes: 10,
    maxAgeHours: 24,
    perAccountDay: 30,
    ...overrides,
  };
}

const send = (cause: string): FallbackDecision => ({ kind: "send", cause }) as FallbackDecision;
const skip = (reason: string, timedOut = false): FallbackDecision =>
  ({ kind: "skip", reason, timedOut }) as FallbackDecision;

/** The table of TASK-052 requirement 1, one row per case. */
const CASES: [string, Partial<FallbackInput>, FallbackDecision | "wait"][] = [
  ["sent, no ack, past the timeout", {}, send("timeout")],
  ["sent, no ack, the timeout exactly", { sentAt: minutesAgo(10) }, send("timeout")],
  ["sent, no ack, within the timeout", { sentAt: minutesAgo(9) }, "wait"],
  ["sent, acked", { ackedAt: minutesAgo(5) }, skip("acked")],
  ["sent, acked within the timeout", { sentAt: minutesAgo(1), ackedAt: NOW }, skip("acked")],
  ["no device — at once", { status: "no_device", createdAt: NOW, sentAt: null }, send("no_device")],
  ["failed — at once", { status: "failed", createdAt: NOW, sentAt: null }, send("failed")],
  [
    "cancelled — as no device",
    { status: "cancelled", createdAt: NOW, sentAt: null },
    send("cancelled"),
  ],
  ["unknown, sent time known, past the timeout", { status: "unknown" }, send("timeout")],
  ["unknown, within the timeout", { status: "unknown", sentAt: minutesAgo(3) }, "wait"],
  [
    "unknown without a send time — from creation",
    { status: "unknown", sentAt: null, createdAt: minutesAgo(10) },
    send("timeout"),
  ],
  [
    "queued within the timeout — waits",
    { status: "queued", sentAt: null, createdAt: minutesAgo(9) },
    "wait",
  ],
  [
    "queued past the timeout from creation",
    { status: "queued", sentAt: null, createdAt: minutesAgo(10) },
    send("timeout"),
  ],
  [
    "unreliable push — at once, while it is still being sent",
    { status: "queued", sentAt: null, createdAt: NOW, unreliable: true },
    send("unreliable"),
  ],
  [
    "unreliable, already sent within the timeout",
    { sentAt: minutesAgo(1), unreliable: true },
    send("unreliable"),
  ],
  ["unreliable but acked", { unreliable: true, ackedAt: NOW }, skip("acked")],
  ["no WhatsApp after the timeout", { whatsapp: false }, skip("no_whatsapp", true)],
  [
    "no WhatsApp, no device",
    { whatsapp: false, status: "no_device", sentAt: null },
    skip("no_whatsapp"),
  ],
  [
    "no WhatsApp within the timeout — still waits",
    { whatsapp: false, sentAt: minutesAgo(2) },
    "wait",
  ],
  ["not a critical kind", { critical: false }, skip("not_critical")],
  ["not critical, no device", { critical: false, status: "no_device" }, skip("not_critical")],
  ["superseded by a later push", { superseded: true }, skip("superseded")],
  ["the subject moved on (an order cancelled)", { current: false }, skip("not_current")],
  ["moved on, no device", { current: false, status: "no_device" }, skip("not_current")],
  ["superseded, no device", { superseded: true, status: "no_device" }, skip("superseded")],
  [
    "older than the window after it fell due",
    { createdAt: minutesAgo(24 * 60 + 12), sentAt: minutesAgo(24 * 60 + 11) },
    skip("stale"),
  ],
  [
    "the window counts from the due moment, not the event",
    { createdAt: minutesAgo(24 * 60 + 5), sentAt: minutesAgo(24 * 60 + 5) },
    send("timeout"),
  ],
  [
    "a timeout as long as the window does not make a due push stale",
    { createdAt: minutesAgo(24 * 60 + 1), sentAt: minutesAgo(24 * 60 + 1), timeoutMinutes: 1440 },
    send("timeout"),
  ],
  [
    "no device older than the window",
    { status: "no_device", sentAt: null, createdAt: minutesAgo(24 * 60 + 11) },
    skip("stale"),
  ],
  ["the limit of the day reached", { fallbacksToday: 30 }, skip("rate_limited", true)],
  ["just under the limit", { fallbacksToday: 29 }, send("timeout")],
  [
    "the limit, no device",
    { fallbacksToday: 30, status: "no_device", sentAt: null },
    skip("rate_limited"),
  ],
];

describe("fallbackDecision", () => {
  it.each(CASES)("%s", (_name, overrides, expected) => {
    const decision = fallbackDecision(input(overrides));
    if (expected === "wait") {
      expect(decision.kind).toBe("wait");
    } else {
      expect(decision).toEqual(expected);
    }
  });

  it("waits until the moment the timeout ends", () => {
    const decision = fallbackDecision(input({ sentAt: minutesAgo(4) }));
    expect(decision).toEqual({ kind: "wait", until: new Date(NOW.getTime() + 6 * 60_000) });
  });

  it("follows the setting of the timeout", () => {
    expect(fallbackDecision(input({ sentAt: minutesAgo(1), timeoutMinutes: 1 })).kind).toBe("send");
    expect(fallbackDecision(input({ sentAt: minutesAgo(11), timeoutMinutes: 15 })).kind).toBe(
      "wait",
    );
  });

  it("counts from creation when nothing was sent yet", () => {
    expect(
      fallbackDueAt({
        status: "queued",
        createdAt: minutesAgo(3),
        sentAt: null,
        timeoutMinutes: 10,
      }),
    ).toEqual(new Date(NOW.getTime() + 7 * 60_000));
  });
});

describe("whatsappAvailable", () => {
  it("is the last decisive word, and yes when nothing is known", () => {
    expect(whatsappAvailable(null)).toBe(true);
    expect(whatsappAvailable({ kind: "whatsapp", source: "message", at: NOW })).toBe(true);
    expect(whatsappAvailable({ kind: "no_whatsapp", source: "login_code", at: NOW })).toBe(false);
  });
});
