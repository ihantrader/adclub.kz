import { countsInStatistics } from "../order/order-statistics";
import {
  ratingPercent,
  ratingShares,
  tallyRatingOrders,
  type RatingOrderFacts,
  type RatingOrderTally,
} from "./supplier-rating";

/**
 * The statistics of a supplier for a period (S-STAT-01; PRODUCT 12.6, 13;
 * TASK-071; ARCHITECTURE 4.89). **The one count of it**: the cabinet's
 * «Статистика» and the admin's card of the supplier show what this returns
 * for the same orders.
 *
 * The orders are those **placed** in the period; a test order of an
 * employee is in none of the numbers (`countsInStatistics`). The shares are
 * the rating's — `ratingOrderOutcome` through `tallyRatingOrders`, the
 * threshold of `ratingShares` — over these orders: an order under order and
 * a service visit are judged by the very table of the rating (4.71 I763),
 * with no rule of their own here.
 */
export interface SupplierPeriodOrders {
  total: number;
  /** Given out; a service — done. */
  completed: number;
  /** Of `completed` — services. */
  completedServices: number;
  cancelledByUser: number;
  declinedBySupplier: number;
  expiredNoResponse: number;
}

export interface SupplierPeriodShares extends RatingOrderTally {
  responseRate: number | null;
  responsePercent: number | null;
  onTimeRate: number | null;
  onTimePercent: number | null;
  minOrders: number;
}

export interface SupplierPeriodStats {
  orders: SupplierPeriodOrders;
  shares: SupplierPeriodShares;
}

export function supplierPeriodStats(
  orders: readonly RatingOrderFacts[],
  minOrders: number,
): SupplierPeriodStats {
  const counted = orders.filter((order) => countsInStatistics(order));
  const count = (test: (order: RatingOrderFacts) => boolean) => counted.filter(test).length;
  const tally = tallyRatingOrders(counted);
  const { responseRate, onTimeRate } = ratingShares(tally, minOrders);
  return {
    orders: {
      total: counted.length,
      completed: count((order) => order.status === "completed"),
      completedServices: count((order) => order.status === "completed" && order.kind === "service"),
      cancelledByUser: count((order) => order.status === "cancelled_by_user"),
      declinedBySupplier: count((order) => order.status === "declined_by_supplier"),
      expiredNoResponse: count((order) => order.status === "response_expired"),
    },
    shares: {
      ...tally,
      responseRate,
      responsePercent: responseRate === null ? null : ratingPercent(responseRate),
      onTimeRate,
      onTimePercent: onTimeRate === null ? null : ratingPercent(onTimeRate),
      minOrders,
    },
  };
}

/** The periods of S-STAT-01, in days. */
export const supplierStatsPeriods = [7, 30, 90] as const;

/** `YYYY-MM-DD` shifted by whole days (a calendar day, not 24 hours of a clock). */
export function shiftCalendarDay(day: string, days: number): string {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/** The last `days` days of Almaty up to `today` (`YYYY-MM-DD` of Almaty), both ends included. */
export function statsPeriodRange(today: string, days: number): { from: string; to: string } {
  return { from: shiftCalendarDay(today, -(Math.max(1, days) - 1)), to: today };
}
