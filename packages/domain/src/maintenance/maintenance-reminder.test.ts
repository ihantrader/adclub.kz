import { describe, expect, it } from "vitest";
import {
  addAlmatyMonths,
  almatyMonthsBetween,
  mileageEstimate,
  nextAlmatyDay,
  readingNear,
  reminderState,
  type ReminderCarInput,
  type ReminderElementInput,
  type ReminderSettings,
} from "./maintenance-reminder";

const SETTINGS: ReminderSettings = { leadKm: 500, leadDays: 14, askDays: 30, windowDays: 180 };
const NOW = new Date("2026-11-13T06:00:00Z"); // 11:00 in Almaty
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);

const oil = (patch: Partial<ReminderElementInput> = {}): ReminderElementInput => ({
  id: "oil",
  position: 0,
  intervalKm: 10_000,
  intervalMonths: 12,
  firstKm: null,
  firstMonths: null,
  basis: null,
  snoozedUntil: null,
  ...patch,
});

const car = (patch: Partial<ReminderCarInput> = {}): ReminderCarInput => ({
  hasPlan: true,
  readings: [],
  knownSince: daysAgo(400),
  ageMonthsAtKnownSince: null,
  mileageQuestionDismissedUntil: null,
  elements: [oil()],
  ...patch,
});

const one = (input: ReminderCarInput) => reminderState(input, SETTINGS, NOW).items[0]!;

describe("reminderState — the last replacement", () => {
  it.each([
    [
      "by an order: 15 000 + 10 000 − 500 → due at 24 600",
      car({
        readings: [{ valueKm: 24_600, at: daysAgo(1) }],
        elements: [
          oil({ basis: { source: "order", atKm: 15_000, at: daysAgo(100), orderId: "o1" } }),
        ],
      }),
      { state: "due", reason: "km", dueKm: 25_000, elapsedKm: 9_600, source: "order" },
    ],
    [
      "by an order: 24 400 is not yet",
      car({
        readings: [{ valueKm: 24_400, at: daysAgo(1) }],
        elements: [
          oil({ basis: { source: "order", atKm: 15_000, at: daysAgo(100), orderId: "o1" } }),
        ],
      }),
      { state: "waiting", reason: null, dueKm: 25_000, elapsedKm: 9_400, source: "order" },
    ],
    [
      "«Уже поменял» at 30 000, now 31 000 — not yet",
      car({
        readings: [{ valueKm: 31_000, at: daysAgo(1) }],
        elements: [oil({ basis: { source: "user", atKm: 30_000, at: daysAgo(20) } })],
      }),
      { state: "waiting", reason: null, dueKm: 40_000, elapsedKm: 1_000, source: "user" },
    ],
    [
      "by the schedule: the journal began at 24 600 → due at 30 000, overdue past 30 100 (with the estimate)",
      car({
        readings: [
          { valueKm: 24_600, at: daysAgo(100) },
          { valueKm: 30_100, at: daysAgo(1) },
        ],
      }),
      { state: "due", reason: "km", dueKm: 30_000, elapsedKm: 10_156, source: "schedule" },
    ],
    [
      "by the schedule with a first time: 4 000 then every 10 000",
      car({
        elements: [oil({ firstKm: 4_000, intervalMonths: null })],
        readings: [{ valueKm: 3_600, at: daysAgo(1) }],
      }),
      { state: "due", reason: "km", dueKm: 4_000, elapsedKm: 3_600, source: "schedule" },
    ],
  ])("%s", (_name, input, expected) => {
    const item = one(input);
    expect({
      state: item.state,
      reason: item.reason,
      dueKm: item.dueKm,
      elapsedKm: item.elapsedKm,
      source: item.basis.source,
    }).toEqual(expected);
  });
});

describe("reminderState — by the mileage and by the date", () => {
  it("an order without readings is counted by the date", () => {
    const item = one(
      car({
        elements: [
          oil({ basis: { source: "order", atKm: null, at: daysAgo(360), orderId: "o1" } }),
        ],
      }),
    );
    expect(item).toMatchObject({ state: "due", reason: "date", dueKm: null, elapsedKm: null });
    expect(item.elapsedMonths).toBe(11);
  });

  it("the date 15 days ahead is not yet; 13 days ahead is", () => {
    const at = (days: number) =>
      one(
        car({
          elements: [
            oil({
              basis: {
                source: "user",
                atKm: null,
                at: new Date(addAlmatyMonths(NOW, -12).getTime() + days * 24 * 60 * 60 * 1000),
              },
            }),
          ],
        }),
      );
    expect(at(15).state).toBe("waiting");
    expect(at(13).state).toBe("due");
  });

  it("whichever first: the date when the mileage is far", () => {
    const item = one(
      car({
        readings: [{ valueKm: 16_000, at: daysAgo(1) }],
        elements: [
          oil({ basis: { source: "order", atKm: 15_000, at: daysAgo(400), orderId: "o1" } }),
        ],
      }),
    );
    expect(item).toMatchObject({ state: "due", reason: "date", elapsedKm: 1_000 });
  });

  it("by the schedule by age: a 22-month car, every 12 months → due at 24", () => {
    const item = one(
      car({
        elements: [oil({ intervalKm: null })],
        knownSince: daysAgo(55),
        ageMonthsAtKnownSince: 22,
      }),
    );
    expect(item.basis.source).toBe("schedule");
    expect(item.state).toBe("due");
    expect(item.reason).toBe("date");
  });

  it("nothing to count by — unknown", () => {
    expect(one(car({ elements: [oil({ intervalMonths: null })] })).state).toBe("unknown");
  });
});

describe("reminderState — the estimate of the mileage", () => {
  it("adds the average daily mileage of the window", () => {
    const state = reminderState(
      car({
        readings: [
          { valueKm: 20_000, at: daysAgo(70) },
          { valueKm: 24_000, at: daysAgo(10) },
        ],
        elements: [oil({ basis: { source: "user", atKm: 15_000, at: daysAgo(100) } })],
      }),
      SETTINGS,
      NOW,
    );
    // 4 000 km in 60 days — about 66.7 a day, 10 days since: 24 667.
    expect(state).toMatchObject({ lastKm: 24_000, currentKm: 24_667, estimated: true });
    expect(state.items[0]).toMatchObject({ state: "due", elapsedKm: 9_667 });
  });

  it.each([
    ["one reading", [{ valueKm: 24_000, at: daysAgo(10) }]],
    [
      "two readings 10 days apart",
      [
        { valueKm: 23_000, at: daysAgo(20) },
        { valueKm: 24_000, at: daysAgo(10) },
      ],
    ],
    [
      "the earlier one outside the window",
      [
        { valueKm: 10_000, at: daysAgo(300) },
        { valueKm: 24_000, at: daysAgo(10) },
      ],
    ],
  ])("no estimate: %s", (_name, readings) => {
    expect(mileageEstimate(readings, NOW, 180)).toMatchObject({
      currentKm: 24_000,
      estimated: false,
    });
  });

  it("a lower reading starts anew, without a negative «прошло»", () => {
    const state = reminderState(
      car({
        readings: [
          { valueKm: 52_000, at: daysAgo(60) },
          { valueKm: 25_000, at: daysAgo(5) },
        ],
        elements: [oil({ basis: { source: "user", atKm: 30_000, at: daysAgo(90) } })],
      }),
      SETTINGS,
      NOW,
    );
    expect(state).toMatchObject({ currentKm: 25_000, estimated: false });
    expect(state.items[0]).toMatchObject({ state: "waiting", elapsedKm: 0 });
  });
});

describe("reminderState — «Напомнить позже», the question, the card", () => {
  const due = car({
    readings: [{ valueKm: 24_800, at: daysAgo(1) }],
    elements: [oil({ basis: { source: "user", atKm: 15_000, at: daysAgo(100) } })],
  });

  it("snoozed while the snooze holds, due after it", () => {
    const snoozed = { ...due, elements: [{ ...due.elements[0]!, snoozedUntil: daysAgo(-3) }] };
    expect(one(snoozed).state).toBe("snoozed");
    expect(reminderState(snoozed, SETTINGS, NOW).top).toBeNull();
    const over = { ...due, elements: [{ ...due.elements[0]!, snoozedUntil: daysAgo(1) }] };
    expect(one(over).state).toBe("due");
  });

  it.each([
    ["no readings", [], null, true],
    ["the last 31 days ago", [{ valueKm: 1, at: daysAgo(31) }], null, true],
    ["the last 29 days ago", [{ valueKm: 1, at: daysAgo(29) }], null, false],
    ["put off until tomorrow", [], daysAgo(-0.5), false],
    ["the put-off is over", [], daysAgo(0.5), true],
  ])("asks the mileage: %s", (_name, readings, dismissed, asked) => {
    expect(
      reminderState(car({ readings, mileageQuestionDismissedUntil: dismissed }), SETTINGS, NOW)
        .askMileage,
    ).toBe(asked);
  });

  it("a reading the same as the last one answers the question too", () => {
    const readings = [{ valueKm: 31_500, at: daysAgo(40) }];
    expect(reminderState(car({ readings }), SETTINGS, NOW).askMileage).toBe(true);
    expect(
      reminderState(car({ readings, mileageConfirmedAt: daysAgo(0) }), SETTINGS, NOW).askMileage,
    ).toBe(false);
  });

  it("no plan — no reminders and no question", () => {
    expect(reminderState(car({ hasPlan: false }), SETTINGS, NOW)).toMatchObject({
      askMileage: false,
      items: [],
      top: null,
    });
  });

  it("two due at once — the card is the most overdue", () => {
    const state = reminderState(
      car({
        readings: [{ valueKm: 30_000, at: daysAgo(1) }],
        elements: [
          oil({ basis: { source: "user", atKm: 19_000, at: daysAgo(50) } }),
          oil({
            id: "pads",
            position: 1,
            intervalKm: 10_000,
            intervalMonths: null,
            basis: { source: "user", atKm: 15_000, at: daysAgo(50) },
          }),
        ],
      }),
      SETTINGS,
      NOW,
    );
    expect(state.items.map((item) => item.state)).toEqual(["due", "due"]);
    expect(state.top?.id).toBe("pads");
  });
});

describe("dates in Almaty", () => {
  it("adds months to the end of a shorter month", () => {
    expect(addAlmatyMonths(new Date("2026-01-30T19:30:00Z"), 1).toISOString()).toBe(
      "2026-02-27T19:30:00.000Z",
    );
  });

  it("counts whole months", () => {
    expect(
      almatyMonthsBetween(new Date("2026-01-15T00:00:00Z"), new Date("2026-03-14T23:00:00Z")),
    ).toBe(1);
    expect(
      almatyMonthsBetween(new Date("2026-03-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z")),
    ).toBe(0);
  });

  it("the next day starts at 00:00 Almaty", () => {
    expect(nextAlmatyDay(new Date("2026-11-13T20:00:00Z")).toISOString()).toBe(
      "2026-11-14T19:00:00.000Z",
    );
  });

  it("the reading nearest to a moment", () => {
    const readings = [
      { valueKm: 10_000, at: daysAgo(100) },
      { valueKm: 15_000, at: daysAgo(40) },
    ];
    expect(readingNear(readings, daysAgo(50))?.valueKm).toBe(15_000);
    expect(readingNear([], NOW)).toBeNull();
  });
});
