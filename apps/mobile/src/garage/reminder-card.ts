import type { GarageReminder, GarageReminderCar, GarageRemindersResponse } from "@adclub/contracts";
import { formatKm } from "./mileage";

/**
 * The one hint card of the catalog's home (SCREENS M-CAT-01, M-REM-01,
 * M-REM-02; TASK-069) — the pure part. Which card, by the order SCREENS
 * gives: «Уточните двигатель» → the mileage question → the reminder. Every
 * fact is the server's (`GET /garage/reminders`, one rule `reminderState`):
 * the app counts nothing, it only chooses what of the answer to show.
 */

export type HomeCard =
  /** «Уточните двигатель — подбор станет точнее». */
  | { kind: "engine" }
  /** M-REM-02 «Какой сейчас пробег у {автомобиль}?». */
  | { kind: "mileage"; carId: string }
  /** M-REM-01 — the most overdue element the server named. */
  | { kind: "reminder"; carId: string; reminder: GarageReminder };

/**
 * The card for the car of the header. Reminders only for a signed-in person
 * whose M-PRO-04 is on (the server answers `enabled: false` otherwise) and
 * only for this car.
 */
export function homeCardOf(
  car: { id: string; engine: unknown },
  reminders: GarageRemindersResponse | null,
): HomeCard | null {
  if (car.engine === null) return { kind: "engine" };
  if (!reminders?.enabled) return null;
  const entry = reminders.cars.find((candidate) => candidate.carId === car.id);
  if (!entry) return null;
  if (entry.askMileage) return { kind: "mileage", carId: car.id };
  const top = topReminderOf(entry);
  return top ? { kind: "reminder", carId: car.id, reminder: top } : null;
}

/** The element the server chose for the card; `null` — nothing is due. */
export function topReminderOf(entry: GarageReminderCar): GarageReminder | null {
  if (entry.topPlanItemId === null) return null;
  const top = entry.reminders.find((reminder) => reminder.planItemId === entry.topPlanItemId);
  return top && top.state === "due" ? top : null;
}

/** The answer of «Уже поменял» / «Напомнить позже» put into the list it came from. */
export function withCar(
  reminders: GarageRemindersResponse | null,
  car: GarageReminderCar,
): GarageRemindersResponse | null {
  if (!reminders) return reminders;
  return {
    ...reminders,
    cars: reminders.cars.map((entry) => (entry.carId === car.carId ? car : entry)),
  };
}

/** A text of M-REM-01: a plain one, or one whose noun takes the plural form of `count`. */
export type ReminderText =
  | {
      plural: false;
      key:
        | "reminder.dueKm"
        | "reminder.scheduleKm"
        | "reminder.serviceDueKm"
        | "reminder.serviceScheduleKm";
      params: Record<string, string>;
    }
  | {
      plural: true;
      key:
        | "reminder.dueMonths"
        | "reminder.scheduleMonths"
        | "reminder.serviceDueMonths"
        | "reminder.serviceScheduleMonths";
      count: number;
      params: Record<string, string>;
    };

/**
 * Which text of M-REM-01 the card says, with its values: «прошло около N км
 * с последней замены» (or «N месяцев») from a known replacement; for one by
 * the plan's schedule — «по регламенту — каждые N км» (it was not seen, so
 * the app does not claim how far it was). A part is «Пора менять {масло}»;
 * a service is «{Замена моторного масла} для {car} — пора» (its name is
 * already the work). `plural` — the key takes the plural form by `count`.
 */
export function reminderTextOf(reminder: GarageReminder, car: string): ReminderText {
  const service = reminder.kind === "service";
  const what = service ? reminder.title.text : reminder.title.text.toLocaleLowerCase();
  const schedule = reminder.basis.source === "schedule";
  const byKm =
    reminder.reason === "km" || (reminder.reason === null && reminder.intervalKm !== null);
  if (schedule) {
    if (byKm && reminder.intervalKm !== null) {
      return {
        key: service ? "reminder.serviceScheduleKm" : "reminder.scheduleKm",
        plural: false,
        params: { what, car, interval: formatKm(reminder.intervalKm) },
      };
    }
    return {
      key: service ? "reminder.serviceScheduleMonths" : "reminder.scheduleMonths",
      plural: true,
      count: reminder.intervalMonths ?? 0,
      params: { what, car },
    };
  }
  if (byKm && reminder.elapsedKm !== null) {
    return {
      key: service ? "reminder.serviceDueKm" : "reminder.dueKm",
      plural: false,
      params: { what, car, km: formatKm(reminder.elapsedKm) },
    };
  }
  return {
    key: service ? "reminder.serviceDueMonths" : "reminder.dueMonths",
    plural: true,
    count: reminder.elapsedMonths ?? 0,
    params: { what, car },
  };
}
