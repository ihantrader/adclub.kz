/**
 * Whether an order counts in the statistics a supplier is judged by
 * (PRODUCT 10.5, 12.6, 13; ARCHITECTURE 4.33; TASK-023 requirement 4).
 * **This is the one place that decides it**, so no counter anywhere has to
 * remember the rule again.
 *
 * An employee ordering from their own company makes a test order
 * (`is_test`, TASK-021, PRODUCT 12.6): the club lets them try the whole
 * path — the code, the scanner, the journal — and none of it may improve
 * or worsen the picture of that supplier. Such an order is still a real
 * order for everyone who works with it: its author, the company and the
 * administrator see it, the supplier answers it, the code gives it out.
 *
 * Who asks:
 *
 * - the discipline of a user (TASK-022): a no-show of a test order is
 *   never marked;
 * - the signal «too many closes by an administrator» of one supplier
 *   (D-043, TASK-022);
 * - the rating of a supplier and the share of orders answered and given
 *   out in time — **TASK-050**, which must take this function (and the SQL
 *   twin `inSupplierStatistics()` of the API) and nothing else;
 * - the signals and the dashboard of the administrator — **TASK-034**.
 *
 * What does *not* ask: the counters of the cabinet's tabs («Новые», «В
 * работе», «Завершённые»). They are the company's own work queue — a test
 * order still needs an answer — and they judge nobody.
 */

/** The facts of an order the decision needs; a row of `customer_order` has them. */
export interface OrderStatisticsFacts {
  /** An employee's own order with their company (PRODUCT 12.6). */
  isTest: boolean;
}

export function countsInStatistics(order: OrderStatisticsFacts): boolean {
  return !order.isTest;
}
