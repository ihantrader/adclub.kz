import { describe, expect, it } from "vitest";
import {
  viewsConversion,
  viewsSignalMove,
  viewsSignalVerdicts,
  type SupplierViewsFigures,
  type ViewsSignalRules,
} from "./views-signal";

const RULES: ViewsSignalRules = { minViews: 200, minSuppliers: 5, ratio: 0.3 };

/** Five ordinary suppliers: 1000 club views each, conversions 10 %, 8 %, 6 %, 5 %, 4 %. */
const ORDINARY: SupplierViewsFigures[] = [100, 80, 60, 50, 40].map((orders, index) => ({
  supplierId: `s${String(index + 1)}`,
  clubViews: 1000,
  orders,
}));

function verdictOf(figures: SupplierViewsFigures[], supplierId: string, rules = RULES) {
  const outcome = viewsSignalVerdicts(figures, rules);
  return { outcome, verdict: outcome.verdicts.find((entry) => entry.supplierId === supplierId)! };
}

describe("viewsSignalVerdicts", () => {
  // The table of cases (TASK-070 AC 1). Median of the five ordinary + the one
  // under test; the threshold is median × 0.3.
  const cases: {
    name: string;
    subject: SupplierViewsFigures;
    others?: SupplierViewsFigures[];
    rules?: ViewsSignalRules;
    gap: boolean;
    judged: boolean;
    threshold: number | null;
  }[] = [
    {
      // Median of 10, 8, 6, 5, 4, 0.5 % = 5.5 %; threshold 1.65 %; 0.5 % is below.
      name: "below the threshold",
      subject: { supplierId: "x", clubViews: 1000, orders: 5 },
      gap: true,
      judged: true,
      threshold: 0.055 * 0.3,
    },
    {
      // Median of 10, 8, 6, 5, 4, 2 % = 5.5 %; threshold 1.65 %; 2 % is above.
      name: "above the threshold",
      subject: { supplierId: "x", clubViews: 1000, orders: 20 },
      gap: false,
      judged: true,
      threshold: 0.055 * 0.3,
    },
    {
      // Exactly at the threshold is not below it.
      name: "exactly at the threshold",
      subject: { supplierId: "x", clubViews: 1000, orders: 15 },
      others: [100, 80, 60, 40, 15].map((orders, index) => ({
        supplierId: `t${String(index)}`,
        clubViews: 1000,
        orders,
      })),
      // conversions 10, 8, 6, 4, 1.5, 1.5 % → median 5 %, threshold 1.5 %.
      gap: false,
      judged: true,
      threshold: 0.05 * 0.3,
    },
    {
      name: "too few views to be judged, even with no orders",
      subject: { supplierId: "x", clubViews: 199, orders: 0 },
      gap: false,
      judged: false,
      // The five ordinary: median 6 %.
      threshold: 0.06 * 0.3,
    },
    {
      name: "too few suppliers for a median",
      subject: { supplierId: "x", clubViews: 1000, orders: 0 },
      others: ORDINARY.slice(0, 3),
      gap: false,
      judged: true,
      threshold: null,
    },
    {
      name: "a median of zero: nobody is below it",
      subject: { supplierId: "x", clubViews: 1000, orders: 0 },
      others: ORDINARY.map((entry) => ({ ...entry, orders: 0 })),
      gap: false,
      judged: true,
      threshold: 0,
    },
    {
      // Median of 10, 8, 6, 5, 4, 0 % = 5.5 %.
      name: "one supplier without orders among ordinary ones",
      subject: { supplierId: "x", clubViews: 1000, orders: 0 },
      gap: true,
      judged: true,
      threshold: 0.055 * 0.3,
    },
    {
      name: "no views at all — not in the median",
      subject: { supplierId: "x", clubViews: 0, orders: 3 },
      gap: false,
      judged: false,
      threshold: 0.06 * 0.3,
    },
    {
      name: "the minimum of suppliers counts the one judged too",
      subject: { supplierId: "x", clubViews: 1000, orders: 0 },
      others: ORDINARY.slice(0, 4),
      // conversions 10, 8, 6, 5, 0 % → median 6 %.
      gap: true,
      judged: true,
      threshold: 0.06 * 0.3,
    },
  ];

  for (const entry of cases) {
    it(entry.name, () => {
      const { outcome, verdict } = verdictOf(
        [...(entry.others ?? ORDINARY), entry.subject],
        entry.subject.supplierId,
        entry.rules,
      );
      expect(verdict.gap).toBe(entry.gap);
      expect(verdict.judged).toBe(entry.judged);
      if (entry.threshold === null) {
        expect(outcome.threshold).toBeNull();
      } else {
        expect(outcome.threshold).toBeCloseTo(entry.threshold, 12);
      }
    });
  }

  it("counts the median of the judged suppliers only", () => {
    const outcome = viewsSignalVerdicts(
      [...ORDINARY, { supplierId: "few", clubViews: 10, orders: 10 }],
      RULES,
    );
    expect(outcome.suppliersInMedian).toBe(5);
    expect(outcome.median).toBeCloseTo(0.06, 12);
  });

  it("has no median without judged suppliers", () => {
    const outcome = viewsSignalVerdicts([], RULES);
    expect(outcome).toEqual({ median: null, suppliersInMedian: 0, threshold: null, verdicts: [] });
  });

  it("gives the conversion of each, null without views", () => {
    expect(viewsConversion(5, 1000)).toBe(0.005);
    expect(viewsConversion(3, 0)).toBeNull();
  });
});

describe("viewsSignalMove", () => {
  const now = new Date("2026-11-15T00:10:00Z");
  const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const base = {
    gap: true,
    conversion: 0.005,
    open: false,
    lastClosed: null,
    windowDays: 30,
    now,
  };

  const cases: {
    name: string;
    input: Partial<Parameters<typeof viewsSignalMove>[0]>;
    move: ReturnType<typeof viewsSignalMove>;
  }[] = [
    { name: "a gap, no signal — open one", input: {}, move: "raise" },
    { name: "a gap, a signal open — refresh it", input: { open: true }, move: "refresh" },
    { name: "no gap, a signal open — close it", input: { gap: false, open: true }, move: "close" },
    { name: "no gap, none open — nothing", input: { gap: false }, move: null },
    {
      name: "closed by an administrator, the same conversion — nothing",
      input: { lastClosed: { byAdmin: true, at: daysAgo(3), conversion: 0.005 } },
      move: null,
    },
    {
      name: "closed by an administrator, a higher conversion — nothing",
      input: { lastClosed: { byAdmin: true, at: daysAgo(3), conversion: 0.004 } },
      move: null,
    },
    {
      // The window moved a day: 0.5 % → 0.49 % is the same gap, not a new fall.
      name: "closed by an administrator, the conversion a little lower — nothing",
      input: {
        conversion: 0.0049,
        lastClosed: { byAdmin: true, at: daysAgo(1), conversion: 0.005 },
      },
      move: null,
    },
    {
      name: "closed by an administrator, exactly a quarter lower — nothing yet",
      input: {
        conversion: 0.006,
        lastClosed: { byAdmin: true, at: daysAgo(3), conversion: 0.008 },
      },
      move: null,
    },
    {
      name: "closed by an administrator, the conversion fell by more than a quarter — open again",
      input: { lastClosed: { byAdmin: true, at: daysAgo(3), conversion: 0.008 } },
      move: "raise",
    },
    {
      name: "closed by an administrator without a conversion in the signal — open again",
      input: { lastClosed: { byAdmin: true, at: daysAgo(3), conversion: null } },
      move: "raise",
    },
    {
      name: "closed by an administrator a whole window ago — open again",
      input: { lastClosed: { byAdmin: true, at: daysAgo(30), conversion: 0.005 } },
      move: "raise",
    },
    {
      name: "closed by the server itself — open again",
      input: { lastClosed: { byAdmin: false, at: daysAgo(1), conversion: 0.005 } },
      move: "raise",
    },
  ];

  for (const entry of cases) {
    it(entry.name, () => {
      expect(viewsSignalMove({ ...base, ...entry.input })).toBe(entry.move);
    });
  }
});
