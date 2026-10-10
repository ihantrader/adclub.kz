import { localDateTime, nextDate } from "../offer/receipt-date";
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

/** Whether the promised date `readyOn` has passed at `at` in `timeZone`. */
export function supplyOverdue(readyOn: string, timeZone: string, at: Date): boolean {
  return localDateTime(at, timeZone).date > readyOn;
}
