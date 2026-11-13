import type { GarageReminder, GarageReminderCar } from "@adclub/contracts";
import { describe, expect, it } from "vitest";
import { filterStateOf } from "../catalog/filters";
import { homeCardOf, reminderTextOf, topReminderOf, withCar } from "./reminder-card";

const CAR = "11111111-1111-4111-8111-111111111111";
const OIL = "22222222-2222-4222-8222-222222222222";
const PADS = "33333333-3333-4333-8333-333333333333";

const reminder = (patch: Partial<GarageReminder> = {}): GarageReminder => ({
  planItemId: OIL,
  title: { text: "Моторное масло", isFallback: false },
  kind: "part",
  state: "due",
  reason: "km",
  intervalKm: 10_000,
  intervalMonths: 12,
  elapsedKm: 9_600,
  elapsedMonths: 7,
  dueKm: 25_000,
  dueAt: null,
  basis: { source: "order", atKm: 15_000, at: null, orderId: null, orderNumber: 1028 },
  snoozedUntil: null,
  catalog: null,
  ...patch,
});

const entry = (patch: Partial<GarageReminderCar> = {}): GarageReminderCar => ({
  carId: CAR,
  hasPlan: true,
  askMileage: false,
  lastMileageKm: 24_400,
  lastMileageAt: null,
  currentKm: 24_600,
  estimated: true,
  reminders: [reminder()],
  topPlanItemId: OIL,
  ...patch,
});

const car = { id: CAR, engine: { id: "e", label: "1.5T" } };

describe("the one hint card of the catalog's home (M-CAT-01)", () => {
  it.each([
    [
      "no engine — «Уточните двигатель» first",
      { id: CAR, engine: null },
      entry({ askMileage: true }),
      "engine",
    ],
    ["the mileage question before the reminder", car, entry({ askMileage: true }), "mileage"],
    ["the reminder the server chose", car, entry(), "reminder"],
    ["nothing due", car, entry({ topPlanItemId: null }), null],
    [
      "the chosen one is snoozed",
      car,
      entry({ reminders: [reminder({ state: "snoozed" })] }),
      null,
    ],
  ])("%s", (_name, header, carEntry, kind) => {
    expect(homeCardOf(header, { enabled: true, cars: [carEntry] })?.kind ?? null).toBe(kind);
  });

  it("nothing of reminders when they are off, for a guest, or for another car", () => {
    expect(homeCardOf(car, { enabled: false, cars: [] })).toBeNull();
    expect(homeCardOf(car, null)).toBeNull();
    expect(
      homeCardOf(
        { ...car, id: "44444444-4444-4444-8444-444444444444" },
        {
          enabled: true,
          cars: [entry()],
        },
      ),
    ).toBeNull();
  });

  it("takes the server's top element, not the first one", () => {
    const pads = reminder({ planItemId: PADS, title: { text: "Колодки", isFallback: false } });
    expect(topReminderOf(entry({ reminders: [reminder(), pads], topPlanItemId: PADS }))).toBe(pads);
  });

  it("puts an answer into the list it came from", () => {
    const answer = entry({ topPlanItemId: null });
    expect(withCar({ enabled: true, cars: [entry()] }, answer)?.cars[0]).toBe(answer);
  });
});

describe("the text of M-REM-01", () => {
  it.each([
    ["since an order, by km", reminder(), "reminder.dueKm", { km: "9 600" }],
    [
      "since «Уже поменял», by the date",
      reminder({
        reason: "date",
        basis: { source: "user", atKm: null, at: null, orderId: null, orderNumber: null },
      }),
      "reminder.dueMonths",
      {},
    ],
    [
      "by the schedule, by km",
      reminder({
        basis: { source: "schedule", atKm: 20_000, at: null, orderId: null, orderNumber: null },
      }),
      "reminder.scheduleKm",
      { interval: "10 000" },
    ],
    [
      "by the schedule, by the date",
      reminder({
        reason: "date",
        basis: { source: "schedule", atKm: null, at: null, orderId: null, orderNumber: null },
      }),
      "reminder.scheduleMonths",
      {},
    ],
  ])("%s", (_name, value, key, params) => {
    const text = reminderTextOf(value, "Geely Coolray 2024");
    expect(text.key).toBe(key);
    expect(text.params).toMatchObject({
      what: "моторное масло",
      car: "Geely Coolray 2024",
      ...params,
    });
  });

  it("names a service as it is, not «менять замена…»", () => {
    const text = reminderTextOf(
      reminder({ kind: "service", title: { text: "Замена моторного масла", isFallback: false } }),
      "Geely Coolray 2024",
    );
    expect(text.key).toBe("reminder.serviceDueKm");
    expect(text.params.what).toBe("Замена моторного масла");
  });

  it("counts months for the plural form", () => {
    const text = reminderTextOf(reminder({ reason: "date" }), "Geely");
    expect(text.plural && text.count).toBe(7);
  });
});

describe("«Подобрать» opens the list with the rule's filters", () => {
  it("turns the server's filters into the state of the filters sheet", () => {
    expect(
      filterStateOf([
        { attributeId: "a", optionIds: ["o1"] },
        { attributeId: "b", min: 4 },
        { attributeId: "c", value: true },
      ]).attributes,
    ).toEqual({
      a: { kind: "options", optionIds: ["o1"] },
      b: { kind: "range", min: 4, max: null },
      c: { kind: "boolean", value: true },
    });
  });
});
