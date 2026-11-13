/**
 * Reminders about a planned replacement (TASK-069; PRODUCT 6.5; SCREENS
 * M-REM-01, M-REM-02, P-REM-01/02; D-038; ARCHITECTURE 4.87). The one rule:
 * the daily job that pushes and the route the app reads both ask this
 * function, with the facts one server service gathers. Nothing here reads a
 * database or a clock — `now` is given.
 *
 * - **the last replacement** of an element is the latest of a finished order
 *   of the car by the element's rule and «Уже поменял» (`source: user`);
 *   without either — the plan's schedule from zero (`schedule`): the
 *   replacements due before the car's journal began are taken as done, and
 *   the next one of the schedule is the one to remind of;
 * - **the current mileage** is the last reading plus the average daily
 *   mileage of the readings of the last `windowDays` (at least two, at least
 *   14 days apart) — otherwise the last reading alone; a reading lower than
 *   the one before it (confirmed «меньше прошлого») starts the count anew;
 * - **it is time** when the mileage is at least «the replacement + the
 *   interval − `leadKm`» or the day is at least «the replacement's date +
 *   the interval in months − `leadDays`» — whichever comes first;
 * - **the mileage is asked** when the car has a plan and no reading, or the
 *   last one is older than `askDays`, unless the question was put off.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Almaty is UTC+5 all year (ARCHITECTURE 13.3): calendar months are counted there. */
const ALMATY_OFFSET_MS = 5 * 60 * 60 * 1000;
/** The shortest stretch between readings an average daily mileage is taken over. */
export const REMINDER_MIN_SPAN_DAYS = 14;

export interface ReminderSettings {
  leadKm: number;
  leadDays: number;
  askDays: number;
  windowDays: number;
}

/** A reading of the journal (`mileage_log`). */
export interface ReminderReading {
  valueKm: number;
  at: Date;
}

/** A replacement that is known: an order of the car, or «Уже поменял». */
export interface ReminderBasis {
  source: "order" | "user";
  /** The mileage then; `null` — unknown (an order without readings): counted by the date. */
  atKm: number | null;
  at: Date;
  orderId?: string | null;
}

export interface ReminderElementInput {
  id: string;
  position: number;
  intervalKm: number | null;
  intervalMonths: number | null;
  firstKm: number | null;
  firstMonths: number | null;
  basis: ReminderBasis | null;
  snoozedUntil: Date | null;
}

export interface ReminderCarInput {
  /** The car has an active plan (`maintenancePlanFor` → `plan`). */
  hasPlan: boolean;
  readings: readonly ReminderReading[];
  /** When the car's history begins for the schedule: it was added to the garage. */
  knownSince: Date;
  /** The car's age at `knownSince`, months (`maintenanceAgeMonths`); `null` — unknown. */
  ageMonthsAtKnownSince: number | null;
  /** «Не сейчас» on the mileage question: not asked until then. */
  mileageQuestionDismissedUntil: Date | null;
  /**
   * The person last confirmed the mileage is still the last reading (the
   * same value again writes no reading, TASK-058): the question is answered.
   */
  mileageConfirmedAt?: Date | null;
  elements: readonly ReminderElementInput[];
}

export type ReminderItemState =
  /** Time to replace: shown and pushed. */
  | "due"
  /** Would be due, but «Напомнить позже» holds it. */
  | "snoozed"
  /** Not yet. */
  | "waiting"
  /** Nothing to count it by: no mileage for a mileage interval, no age for a months one. */
  | "unknown";

export interface ReminderItem {
  id: string;
  state: ReminderItemState;
  /** What made it due: the mileage or the date; `null` — not due. */
  reason: "km" | "date" | null;
  /** The replacement the count is from. */
  basis: {
    source: "order" | "user" | "schedule";
    atKm: number | null;
    at: Date | null;
    orderId: string | null;
  };
  dueKm: number | null;
  dueDate: Date | null;
  /** «прошло около N км» — never below zero; `null` — unknown. */
  elapsedKm: number | null;
  /** «прошло N месяцев» — never below zero; `null` — unknown. */
  elapsedMonths: number | null;
  /** How far past its time, as a share of its interval (the most overdue first); 0 — not past. */
  overdue: number;
}

export interface ReminderCarState {
  /** The last reading; `null` — none. */
  lastKm: number | null;
  lastReadingAt: Date | null;
  /** The mileage counted on: the estimate, or the last reading. */
  currentKm: number | null;
  /** Whether `currentKm` is an estimate (an average daily mileage was known). */
  estimated: boolean;
  askMileage: boolean;
  /** Every element, in the plan's order. */
  items: ReminderItem[];
  /** The one card of the catalog's home: the most overdue due element; `null` — none. */
  top: ReminderItem | null;
}

/** A date plus whole calendar months, in Almaty. */
export function addAlmatyMonths(at: Date, months: number): Date {
  const local = new Date(at.getTime() + ALMATY_OFFSET_MS);
  const day = local.getUTCDate();
  local.setUTCDate(1);
  local.setUTCMonth(local.getUTCMonth() + months);
  const last = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 0)).getUTCDate();
  local.setUTCDate(Math.min(day, last));
  return new Date(local.getTime() - ALMATY_OFFSET_MS);
}

/** Whole calendar months from `from` to `to`, in Almaty; never below zero. */
export function almatyMonthsBetween(from: Date, to: Date): number {
  if (to.getTime() <= from.getTime()) return 0;
  const a = new Date(from.getTime() + ALMATY_OFFSET_MS);
  const b = new Date(to.getTime() + ALMATY_OFFSET_MS);
  let months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth();
  if (addAlmatyMonths(from, months).getTime() > to.getTime()) months -= 1;
  return Math.max(0, months);
}

/** The start of the next day in Almaty («Не сейчас» — until then). */
export function nextAlmatyDay(now: Date): Date {
  const local = new Date(now.getTime() + ALMATY_OFFSET_MS);
  const start = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1);
  return new Date(start - ALMATY_OFFSET_MS);
}

/**
 * The reading nearest to a moment (an order given out): the mileage of the
 * replacement it made; `null` — no readings.
 */
export function readingNear(
  readings: readonly ReminderReading[],
  at: Date,
): ReminderReading | null {
  let best: ReminderReading | null = null;
  for (const reading of readings) {
    if (
      best === null ||
      Math.abs(reading.at.getTime() - at.getTime()) < Math.abs(best.at.getTime() - at.getTime())
    ) {
      best = reading;
    }
  }
  return best;
}

/** The readings in time order since the last one lower than the one before it. */
function currentStretch(readings: readonly ReminderReading[]): ReminderReading[] {
  const sorted = [...readings].sort((a, b) => a.at.getTime() - b.at.getTime());
  let start = 0;
  for (let index = 1; index < sorted.length; index++) {
    if (sorted[index]!.valueKm < sorted[index - 1]!.valueKm) start = index;
  }
  return sorted.slice(start);
}

/** The mileage now: the last reading plus the average daily mileage, when it is known. */
export function mileageEstimate(
  readings: readonly ReminderReading[],
  now: Date,
  windowDays: number,
): { lastKm: number | null; lastAt: Date | null; currentKm: number | null; estimated: boolean } {
  const stretch = currentStretch(readings);
  const last = stretch.at(-1);
  if (!last) return { lastKm: null, lastAt: null, currentKm: null, estimated: false };
  const recent = stretch.filter(
    (reading) => reading.at.getTime() >= now.getTime() - windowDays * DAY_MS,
  );
  const first = recent[0];
  const end = recent.at(-1);
  if (recent.length >= 2 && first && end) {
    const spanDays = (end.at.getTime() - first.at.getTime()) / DAY_MS;
    const perDay =
      spanDays >= REMINDER_MIN_SPAN_DAYS ? (end.valueKm - first.valueKm) / spanDays : 0;
    if (perDay > 0) {
      const since = Math.max(0, (now.getTime() - last.at.getTime()) / DAY_MS);
      return {
        lastKm: last.valueKm,
        lastAt: last.at,
        currentKm: Math.round(last.valueKm + perDay * since),
        estimated: true,
      };
    }
  }
  return { lastKm: last.valueKm, lastAt: last.at, currentKm: last.valueKm, estimated: false };
}

/**
 * The points of a schedule: the first time (when given), then the multiples
 * of the interval after it — as `dueMaintenance` counts them.
 */
function previousPoint(at: number, interval: number | null, first: number | null): number {
  let best = 0;
  if (first !== null && first <= at) best = first;
  if (interval !== null && interval > 0) {
    const multiple = Math.floor(at / interval) * interval;
    if (multiple > (first ?? 0) && multiple > best) best = multiple;
  }
  return best;
}

function nextPoint(after: number, interval: number | null, first: number | null): number | null {
  if (first !== null && after < first) return first;
  if (interval === null || interval <= 0) return null;
  const from = Math.max(after, first ?? 0);
  return (Math.floor(from / interval) + 1) * interval;
}

function itemOf(
  element: ReminderElementInput,
  car: ReminderCarInput,
  mileage: ReturnType<typeof mileageEstimate>,
  firstReading: ReminderReading | null,
  settings: ReminderSettings,
  now: Date,
): ReminderItem {
  const current = mileage.currentKm;
  let basis: ReminderItem["basis"];
  let dueKm: number | null = null;
  let dueDate: Date | null = null;
  let elapsedKm: number | null = null;
  let elapsedMonths: number | null = null;

  if (element.basis) {
    const known = element.basis;
    basis = {
      source: known.source,
      atKm: known.atKm,
      at: known.at,
      orderId: known.orderId ?? null,
    };
    if (known.atKm !== null && element.intervalKm !== null) dueKm = known.atKm + element.intervalKm;
    if (element.intervalMonths !== null)
      dueDate = addAlmatyMonths(known.at, element.intervalMonths);
    if (known.atKm !== null && current !== null) elapsedKm = Math.max(0, current - known.atKm);
    elapsedMonths = almatyMonthsBetween(known.at, now);
  } else {
    // The schedule from zero: what was due before the journal began is taken as done.
    let baseKm: number | null = null;
    if (firstReading && (element.intervalKm !== null || element.firstKm !== null)) {
      baseKm = previousPoint(firstReading.valueKm, element.intervalKm, element.firstKm);
      dueKm = nextPoint(baseKm, element.intervalKm, element.firstKm);
      if (current !== null) elapsedKm = Math.max(0, current - baseKm);
    }
    let baseAt: Date | null = null;
    const age = car.ageMonthsAtKnownSince;
    if (age !== null && (element.intervalMonths !== null || element.firstMonths !== null)) {
      const baseAge = previousPoint(age, element.intervalMonths, element.firstMonths);
      const dueAge = nextPoint(baseAge, element.intervalMonths, element.firstMonths);
      baseAt = addAlmatyMonths(car.knownSince, baseAge - age);
      if (dueAge !== null) dueDate = addAlmatyMonths(car.knownSince, dueAge - age);
      elapsedMonths = almatyMonthsBetween(baseAt, now);
    }
    basis = { source: "schedule", atKm: baseKm, at: baseAt, orderId: null };
  }

  const kmDue =
    dueKm !== null && current !== null && current >= dueKm - settings.leadKm
      ? (current - dueKm) / (element.intervalKm ?? element.firstKm ?? 1)
      : null;
  const dateDue =
    dueDate !== null && now.getTime() >= dueDate.getTime() - settings.leadDays * DAY_MS
      ? (now.getTime() - dueDate.getTime()) /
        (((element.intervalMonths ?? element.firstMonths ?? 1) * 365.25 * DAY_MS) / 12)
      : null;
  const countable = (dueKm !== null && current !== null) || dueDate !== null;
  let reason: ReminderItem["reason"] = null;
  if (kmDue !== null && (dateDue === null || kmDue >= dateDue)) reason = "km";
  else if (dateDue !== null) reason = "date";
  const overdue = Math.max(
    0,
    kmDue ?? Number.NEGATIVE_INFINITY,
    dateDue ?? Number.NEGATIVE_INFINITY,
  );
  let state: ReminderItemState;
  if (reason === null) state = countable ? "waiting" : "unknown";
  else if (element.snoozedUntil && element.snoozedUntil.getTime() > now.getTime())
    state = "snoozed";
  else state = "due";
  return {
    id: element.id,
    state,
    reason,
    basis,
    dueKm,
    dueDate,
    elapsedKm,
    elapsedMonths,
    overdue: reason === null ? 0 : overdue,
  };
}

/** What a car is to be reminded of now — the one rule (TASK-069). */
export function reminderState(
  car: ReminderCarInput,
  settings: ReminderSettings,
  now: Date,
): ReminderCarState {
  const mileage = mileageEstimate(car.readings, now, settings.windowDays);
  if (!car.hasPlan) {
    return {
      lastKm: mileage.lastKm,
      lastReadingAt: mileage.lastAt,
      currentKm: mileage.currentKm,
      estimated: mileage.estimated,
      askMileage: false,
      items: [],
      top: null,
    };
  }
  const firstReading = currentStretch(car.readings)[0] ?? null;
  const items = [...car.elements]
    .sort((a, b) => a.position - b.position)
    .map((element) => itemOf(element, car, mileage, firstReading, settings, now));
  const lastAnswer = Math.max(
    mileage.lastAt?.getTime() ?? Number.NEGATIVE_INFINITY,
    car.mileageConfirmedAt?.getTime() ?? Number.NEGATIVE_INFINITY,
  );
  const stale = now.getTime() - lastAnswer >= settings.askDays * DAY_MS;
  const putOff =
    car.mileageQuestionDismissedUntil !== null &&
    car.mileageQuestionDismissedUntil.getTime() > now.getTime();
  let top: ReminderItem | null = null;
  for (const item of items) {
    if (item.state === "due" && (top === null || item.overdue > top.overdue)) top = item;
  }
  return {
    lastKm: mileage.lastKm,
    lastReadingAt: mileage.lastAt,
    currentKm: mileage.currentKm,
    estimated: mileage.estimated,
    askMileage: stale && !putOff,
    items,
    top,
  };
}
