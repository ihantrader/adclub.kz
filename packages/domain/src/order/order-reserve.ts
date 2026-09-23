import { localDateTime, receiptDate, type ReceiptSchedule } from "../offer/receipt-date";

/**
 * How long an accepted pickup order waits for the user (PRODUCT 10.2,
 * 10.4; ARCHITECTURE 6.1, 13.2, 4.31; TASK-021). The reserve lasts the
 * setting `pickup_reserve_hours`, fixed on the order when it enters the
 * status (13.4: a later change of the setting doesn't move it):
 *
 * - on accepting, it counts from the moment the user can come for the
 *   item — the receipt date of the order's term by the point's schedule
 *   (`receiptDate`, the one rule of TASK-018): accepted today while the
 *   point still works — from now; accepted after closing, before a day
 *   off, or with a term of working days — from the start of that date in
 *   the point's time zone, so the reserve never runs out before the point
 *   opens again. No receipt date (the point's hours were removed after
 *   the order was created) — from now;
 * - «ready» starts the reserve again from that moment (SCREENS M-ORD-01
 *   «после готовности заказ держат для вас N суток») but never shortens a
 *   reserve already promised;
 * - the warning «the reserve is ending» is due `reserve_warning_hours`
 *   before the end, not before the reserve began.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function dateValue(date: string): number {
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

/** The instant a calendar date begins in a time zone. */
export function startOfLocalDate(date: string, timeZone: string): Date {
  const wanted = dateValue(date);
  let guess = wanted;
  // An offset is found in one step; a second one settles a DST edge.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const local = localDateTime(new Date(guess), timeZone);
    const off = ((dateValue(local.date) - wanted) / DAY_MS) * 24 * 60 + local.minutes;
    if (off === 0) {
      break;
    }
    guess -= off * 60 * 1000;
  }
  return new Date(guess);
}

/** The end of the reserve of a pickup order accepted at `acceptedAt`. */
export function acceptedReserveEnd(
  acceptedAt: Date,
  leadDays: number,
  schedule: ReceiptSchedule | null,
  reserveHours: number,
): Date {
  let start = acceptedAt;
  if (schedule) {
    const receipt = receiptDate(acceptedAt, leadDays, schedule);
    if (receipt.ok && receipt.date > receipt.confirmedOn) {
      const opens = startOfLocalDate(receipt.date, schedule.timeZone);
      if (opens > start) {
        start = opens;
      }
    }
  }
  return new Date(start.getTime() + reserveHours * HOUR_MS);
}

/** The end of the reserve once the order is ready at `readyAt`: never earlier than `current`. */
export function readyReserveEnd(current: Date | null, readyAt: Date, reserveHours: number): Date {
  const fresh = new Date(readyAt.getTime() + reserveHours * HOUR_MS);
  return current && current > fresh ? current : fresh;
}

/** When to warn that the reserve ends at `end`: `warningHours` before it, not before `from`. */
export function reserveWarningAt(end: Date, warningHours: number, from: Date): Date {
  const at = new Date(end.getTime() - warningHours * HOUR_MS);
  return at > from ? at : from;
}
