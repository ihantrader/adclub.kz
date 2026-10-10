import { localDateTime, nextDate, receiptDate, type ReceiptSchedule } from "../offer/receipt-date";
import { startOfLocalDate } from "./order-reserve";

/**
 * The term of an order under order (PRODUCT 10.3, 10.4; ARCHITECTURE 6.2,
 * 4.59; TASK-037). The date a term of working days gives is always
 * `receiptDate` of TASK-018 — one rule for the showcase, the order and the
 * proposal; here are only the rules around it:
 *
 * - **another term** the supplier proposes is a whole number of working
 *   days of the company, at least 1 and at most `offer_lead_days_max`, and
 *   not the term the user already agreed to (that one is confirmed by
 *   «Подтвердить срок», not proposed);
 * - **the user's answer** is due `term_agreement_hours` after the proposal;
 * - **the supply is overdue** once the confirmed date has passed in the
 *   point's time zone — from the first moment of the next day there — and
 *   the order is still not ready.
 */

/** Why a proposed term is not one: `same_term` — it is the term already agreed; `out_of_range` — 0 or above the bound. */
export type ProposedTermProblem = "same_term" | "out_of_range";

export function proposedTermProblem(
  leadDays: number,
  agreedLeadDays: number,
  maxLeadDays: number,
): ProposedTermProblem | null {
  if (!Number.isInteger(leadDays) || leadDays < 1 || leadDays > maxLeadDays) {
    return "out_of_range";
  }
  return leadDays === agreedLeadDays ? "same_term" : null;
}

const HOUR_MS = 60 * 60 * 1000;

/** Until when the user may answer a term proposed at `at`. */
export function termAnswerBy(at: Date, agreementHours: number): Date {
  return new Date(at.getTime() + agreementHours * HOUR_MS);
}

/**
 * The moment the supply of an order whose goods were promised on `readyOn`
 * (the point's own calendar date) becomes overdue: the start of the next day
 * in the point's time zone.
 */
export function supplyOverdueAt(readyOn: string, timeZone: string): Date {
  return startOfLocalDate(nextDate(readyOn), timeZone);
}

/** One date another term may be: its working days and the date they give. */
export interface TermOption {
  leadDays: number;
  readyOn: string;
}

/**
 * The dates another term may be at `at` (TASK-039; SCREENS S-ORD-04
 * «рабочие дни компании»): for every term from 1 to `maxLeadDays` working
 * days, the date `receiptDate` gives — each term a working day of its own,
 * nearest first. The agreed term is left out, and so is its date: proposing
 * the date the customer has already agreed to is no other term. Empty — the
 * point has no working day to count by.
 */
export function termOptions(
  at: Date,
  schedule: ReceiptSchedule,
  agreedLeadDays: number,
  maxLeadDays: number,
): TermOption[] {
  const agreed = receiptDate(at, Math.max(0, agreedLeadDays), schedule);
  const agreedOn = agreed.ok ? agreed.date : null;
  const options: TermOption[] = [];
  for (let leadDays = 1; leadDays <= maxLeadDays; leadDays += 1) {
    if (leadDays === agreedLeadDays) continue;
    const receipt = receiptDate(at, leadDays, schedule);
    if (!receipt.ok) return [];
    if (receipt.date === agreedOn) continue;
    options.push({ leadDays, readyOn: receipt.date });
  }
  return options;
}

/**
 * The term in working days that gives exactly `readyOn` among `options`
 * (`termOptions` of the same moment); `null` — the date is no option: not a
 * working day of the point, past the bound, or the agreed one.
 */
export function leadDaysForDate(options: readonly TermOption[], readyOn: string): number | null {
  return options.find((option) => option.readyOn === readyOn)?.leadDays ?? null;
}

/** Whether the promised date `readyOn` has passed at `at` in `timeZone`. */
export function supplyOverdue(readyOn: string, timeZone: string, at: Date): boolean {
  return localDateTime(at, timeZone).date > readyOn;
}
