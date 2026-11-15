/**
 * The signal «Просмотров много, заявок мало» (`views_orders_gap`; TASK-070;
 * PRODUCT 13, 16; ARCHITECTURE 4.88): a supplier whose offers members of the
 * club look at a lot but who gets few orders may be taking the clients past
 * the platform. The rule is these two functions; the numbers are counted once
 * on the server (`offer-views/view-facts.ts`), and the signal decides nothing:
 * a person looks.
 *
 * - **Who is judged:** a supplier with at least `minViews` views by members
 *   of the club (`club`) in the window. Only they see the supplier's name and
 *   address (D-005), so only their views can turn into going around.
 * - **Conversion:** orders that count in statistics (no test orders) ÷ those
 *   views.
 * - **Median:** of the conversions of every judged supplier. With fewer than
 *   `minSuppliers` of them there is nothing to compare with — no signal.
 * - **Gap:** the conversion is below median × `ratio`. A median of 0 makes a
 *   threshold of 0, and nobody is below it.
 */

export interface ViewsSignalRules {
  /** `views_signal_min`: views by members of the club in the window to be judged. */
  minViews: number;
  /** `views_signal_min_suppliers`: judged suppliers for a median at all. */
  minSuppliers: number;
  /** `views_signal_ratio`: the share of the median below which it is a gap. */
  ratio: number;
}

/** What a supplier had in the window. */
export interface SupplierViewsFigures {
  supplierId: string;
  /** Views of its offers by members of the club. */
  clubViews: number;
  /** Its orders that count in statistics. */
  orders: number;
}

export interface ViewsSignalVerdict {
  supplierId: string;
  clubViews: number;
  orders: number;
  /** orders ÷ club views; `null` — no views. */
  conversion: number | null;
  /** Enough views to be judged (and to be in the median). */
  judged: boolean;
  /** A gap: judged, the median counts, and the conversion is below the threshold. */
  gap: boolean;
}

export interface ViewsSignalOutcome {
  /** The median conversion of the judged suppliers; `null` — none judged. */
  median: number | null;
  /** How many suppliers are in the median. */
  suppliersInMedian: number;
  /** median × ratio; `null` — too few suppliers for a median to count. */
  threshold: number | null;
  verdicts: ViewsSignalVerdict[];
}

/** orders ÷ views; no views — `null`. */
export function viewsConversion(orders: number, views: number): number | null {
  return views > 0 ? orders / views : null;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** The verdict of every supplier of the window by the rule above. */
export function viewsSignalVerdicts(
  figures: readonly SupplierViewsFigures[],
  rules: ViewsSignalRules,
): ViewsSignalOutcome {
  const judged = figures.filter((entry) => entry.clubViews >= rules.minViews);
  const middle = median(judged.map((entry) => entry.orders / entry.clubViews));
  const threshold =
    middle !== null && judged.length >= rules.minSuppliers ? middle * rules.ratio : null;
  return {
    median: middle,
    suppliersInMedian: judged.length,
    threshold,
    verdicts: figures.map((entry) => {
      const conversion = viewsConversion(entry.orders, entry.clubViews);
      const isJudged = entry.clubViews >= rules.minViews;
      return {
        supplierId: entry.supplierId,
        clubViews: entry.clubViews,
        orders: entry.orders,
        conversion,
        judged: isJudged,
        gap: isJudged && threshold !== null && conversion !== null && conversion < threshold,
      };
    }),
  };
}

/**
 * What the daily job does to the signal of one supplier (as «Низкий рейтинг»,
 * TASK-050):
 *
 * - no gap — close the one open (the fact is over), else nothing;
 * - a gap and an open signal — refresh its numbers;
 * - a gap and none open — open one, **unless** an administrator closed the
 *   last one less than `windowDays` ago and the conversion has not fallen
 *   below `VIEWS_SIGNAL_NEW_FALL` of the one that signal showed: the
 *   administrator has dealt with this very gap. The window moves a day at a
 *   time, so the conversion wobbles a little every night; only a real fall
 *   (a quarter lower) is a new one. A whole window after the close the
 *   numbers are all new — that opens the signal again too. A signal the
 *   server closed by itself does not hold anything back.
 */
export const VIEWS_SIGNAL_NEW_FALL = 0.75;

export function viewsSignalMove(input: {
  gap: boolean;
  conversion: number | null;
  /** A signal of the supplier is not closed (new or in work). */
  open: boolean;
  /** The latest closed signal of the supplier, if there is one. */
  lastClosed: { byAdmin: boolean; at: Date; conversion: number | null } | null;
  windowDays: number;
  now: Date;
}): "raise" | "refresh" | "close" | null {
  if (!input.gap) {
    return input.open ? "close" : null;
  }
  if (input.open) {
    return "refresh";
  }
  const closed = input.lastClosed;
  if (closed?.byAdmin) {
    const withinWindow =
      input.now.getTime() - closed.at.getTime() < input.windowDays * 24 * 60 * 60 * 1000;
    const lower =
      closed.conversion === null ||
      (input.conversion !== null && input.conversion < closed.conversion * VIEWS_SIGNAL_NEW_FALL);
    if (withinWindow && !lower) {
      return null;
    }
  }
  return "raise";
}
