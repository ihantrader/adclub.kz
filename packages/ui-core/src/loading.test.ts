import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  contentSwap,
  createLoadingGate,
  loadingRule,
  motion,
  motionPlan,
  type LoadingClock,
} from "./index";

const design = readFileSync(join(__dirname, "../../../DESIGN.md"), "utf8");

/** The DESIGN 7.6 line «Загрузка без мигания». */
const rule = design.split("\n").find((line) => line.startsWith("- **Загрузка без мигания**")) ?? "";

/** A clock the test moves by hand. */
function fakeClock() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock: LoadingClock = {
    now: () => now,
    setTimeout(callback, ms) {
      const id = next++;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
  };
  /** Moves the time to `to`, firing every timer due on the way, in order. */
  const advanceTo = (to: number) => {
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= to)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].callback();
    }
    now = to;
  };
  return { clock, advanceTo, now: () => now };
}

/** Records when the indicator changed and when the answer was shown. */
function watched() {
  const time = fakeClock();
  const gate = createLoadingGate(time.clock);
  const indicator: Array<[number, boolean]> = [];
  let last = false;
  gate.subscribe(() => {
    if (gate.indicator !== last) {
      last = gate.indicator;
      indicator.push([time.now(), last]);
    }
  });
  const shown: Array<[number, string]> = [];
  const show = (what: string) => () => shown.push([time.now(), what]);
  return { ...time, gate, indicator, shown, show };
}

describe("the numbers of the rule are DESIGN 7.6 «Загрузка без мигания»", () => {
  it("300 ms before an indicator, 500 ms at least on screen, a 150 ms fade", () => {
    expect(rule).not.toBe("");
    expect(rule).toContain(`дольше **${loadingRule.showAfterMs} мс**`);
    expect(rule).toContain(`не меньше **${loadingRule.minVisibleMs} мс**`);
    expect(rule).toContain(`растворением **${contentSwap(false).durationMs} мс**`);
    expect(loadingRule).toMatchObject({ showAfterMs: 300, minVisibleMs: 500 });
    expect(contentSwap(false).durationMs).toBe(motion.fast);
  });

  it("is a continuation of motionPlan: the same duration and curve as something appearing", () => {
    const plan = motionPlan("appear", false);
    expect(contentSwap(false)).toMatchObject({
      fades: true,
      durationMs: plan.durationMs,
      easing: plan.easing,
    });
    expect(contentSwap(false).fromOpacity).toBe(loadingRule.dimOpacity);
    expect(loadingRule.dimOpacity).toBeGreaterThan(0);
    expect(loadingRule.dimOpacity).toBeLessThan(1);
  });
});

describe("a quick answer", () => {
  it("is shown at once, with no indicator at all", () => {
    const { gate, advanceTo, indicator, shown, show } = watched();
    const ticket = gate.begin();
    advanceTo(50);
    gate.settle(ticket, show("answer"));
    advanceTo(2000);
    expect(shown).toEqual([[50, "answer"]]);
    expect(indicator).toEqual([]);
    expect(gate.pending).toBe(false);
  });

  it("just under the delay is still quick", () => {
    const { gate, advanceTo, indicator, shown, show } = watched();
    const ticket = gate.begin();
    advanceTo(299);
    gate.settle(ticket, show("answer"));
    advanceTo(1000);
    expect(shown).toEqual([[299, "answer"]]);
    expect(indicator).toEqual([]);
  });
});

describe("a slow answer", () => {
  it("at 350 ms: the indicator appears at 300 and the answer comes with its end at 800", () => {
    const { gate, advanceTo, indicator, shown, show } = watched();
    const ticket = gate.begin();
    advanceTo(350);
    expect(gate.indicator).toBe(true);
    gate.settle(ticket, show("answer"));
    expect(shown).toEqual([]);
    expect(gate.pending).toBe(true);
    advanceTo(5000);
    expect(indicator).toEqual([
      [300, true],
      [800, false],
    ]);
    expect(shown).toEqual([[800, "answer"]]);
  });

  it("is never held longer than the minimum: at 2 s it is shown at 2 s", () => {
    const { gate, advanceTo, indicator, shown, show } = watched();
    const ticket = gate.begin();
    advanceTo(2000);
    gate.settle(ticket, show("answer"));
    expect(shown).toEqual([[2000, "answer"]]);
    expect(indicator).toEqual([
      [300, true],
      [2000, false],
    ]);
  });

  it("an error is an answer like any other — held by the same rule", () => {
    const { gate, advanceTo, shown, show } = watched();
    const ticket = gate.begin();
    advanceTo(400);
    gate.settle(ticket, show("error"));
    advanceTo(900);
    expect(shown).toEqual([[800, "error"]]);
  });
});

describe("loads one after another", () => {
  it("show only the last one; an earlier answer arriving late is ignored", () => {
    const { gate, advanceTo, shown, show } = watched();
    const onSale = gate.begin();
    advanceTo(100);
    const withdrawn = gate.begin();
    advanceTo(150);
    const onSaleAgain = gate.begin();
    advanceTo(200);
    gate.settle(withdrawn, show("withdrawn"));
    gate.settle(onSale, show("on sale (first)"));
    advanceTo(250);
    gate.settle(onSaleAgain, show("on sale"));
    advanceTo(3000);
    expect(shown).toEqual([[250, "on sale"]]);
  });

  it("keep one indicator on screen without blinking, timed from when it first appeared", () => {
    const { gate, advanceTo, indicator, shown, show } = watched();
    gate.begin();
    advanceTo(400); // the indicator is on since 300
    const second = gate.begin();
    advanceTo(600);
    gate.settle(second, show("second"));
    advanceTo(3000);
    expect(indicator).toEqual([
      [300, true],
      [800, false],
    ]);
    expect(shown).toEqual([[800, "second"]]);
  });

  it("drop an answer held for the minimum when a newer load begins", () => {
    const { gate, advanceTo, indicator, shown, show } = watched();
    const first = gate.begin();
    advanceTo(350);
    gate.settle(first, show("first")); // held until 800
    advanceTo(500);
    const second = gate.begin();
    advanceTo(1200);
    gate.settle(second, show("second"));
    advanceTo(3000);
    expect(shown).toEqual([[1200, "second"]]);
    expect(indicator).toEqual([
      [300, true],
      [1200, false],
    ]);
  });

  it("start a fresh delay once the previous load is over", () => {
    const { gate, advanceTo, indicator, shown, show } = watched();
    const first = gate.begin();
    advanceTo(100);
    gate.settle(first, show("first"));
    advanceTo(1000);
    const second = gate.begin();
    advanceTo(1250);
    gate.settle(second, show("second"));
    expect(indicator).toEqual([]);
    expect(shown).toEqual([
      [100, "first"],
      [1250, "second"],
    ]);
  });
});

describe("an abandoned load", () => {
  it("shows nothing, and takes an indicator away only after its minimum", () => {
    const { gate, advanceTo, indicator, shown, show } = watched();
    const ticket = gate.begin();
    advanceTo(400);
    gate.cancel();
    gate.settle(ticket, show("late"));
    advanceTo(3000);
    expect(shown).toEqual([]);
    expect(indicator).toEqual([
      [300, true],
      [800, false],
    ]);
  });

  it("before the delay — no indicator ever", () => {
    const { gate, advanceTo, indicator } = watched();
    gate.begin();
    advanceTo(100);
    gate.cancel();
    advanceTo(3000);
    expect(indicator).toEqual([]);
    expect(gate.pending).toBe(false);
  });

  it("a disposed gate fires nothing and may begin again", () => {
    const { gate, advanceTo, indicator, shown, show } = watched();
    const ticket = gate.begin();
    gate.dispose();
    gate.settle(ticket, show("old"));
    advanceTo(1000);
    expect(indicator).toEqual([]);
    const next = gate.begin();
    advanceTo(1100);
    gate.settle(next, show("new"));
    expect(shown).toEqual([[1100, "new"]]);
  });
});

describe("«Уменьшить движение»", () => {
  it("drops the fade of the content swap", () => {
    expect(contentSwap(true).fades).toBe(false);
  });

  it("keeps the delay and the minimum: they remove flicker, not motion", () => {
    // The gate has no notion of reduced motion: the same timing for everyone.
    const { gate, advanceTo, indicator, shown, show } = watched();
    const ticket = gate.begin();
    advanceTo(100);
    gate.settle(ticket, show("answer"));
    expect(indicator).toEqual([]);
    expect(shown).toEqual([[100, "answer"]]);
    expect(rule).toContain("задержка показа индикатора остаётся");
  });
});
