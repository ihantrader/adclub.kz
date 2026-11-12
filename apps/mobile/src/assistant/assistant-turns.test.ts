import { describe, expect, it } from "vitest";
import type { GarageCar } from "../garage/garage";
import { createLoadingGate, type LoadingClock } from "@adclub/ui-core";
import { answerCarOf, createAssistantTurns, loadDialog, mileageOfferOf } from "./assistant-turns";

/** Open keys key-1, key-2, … in order. */
function keys(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `key-${String(n)}`;
  };
}

function car(id: string, model: string, mileageKm: number | null = null): GarageCar {
  return {
    id,
    make: { id: "make-geely", label: "Geely" },
    model: { id: `model-${model}`, label: model },
    year: 2024,
    generation: null,
    body: null,
    engine: null,
    transmission: null,
    drive: null,
    modificationId: null,
    color: null,
    vin: null,
    plate: null,
    document: null,
    mileage:
      mileageKm === null
        ? null
        : { valueKm: mileageKm, source: "text", recordedAt: "2026-11-12T10:00:00.000Z" },
    addedAt: "2026-11-12T10:00:00.000Z",
  } as GarageCar;
}

/** Lets every queued promise callback run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe("answerCarOf — the car an answer was given for", () => {
  const coolray = car("c1", "Coolray");
  const atlas = car("c2", "Atlas");

  it("is the dialog's car, whatever car the header shows", () => {
    expect(answerCarOf([atlas, coolray], "c1")).toBe(coolray);
  });

  it("is none when the dialog's car is gone or there is no dialog", () => {
    expect(answerCarOf([atlas], "c1")).toBeNull();
    expect(answerCarOf([atlas, coolray], null)).toBeNull();
  });
});

describe("mileageOfferOf — «Обновить пробег» of the answer's car", () => {
  const suggestion = { km: 20_000 };

  it("asks when the answer's car has another mileage", () => {
    expect(mileageOfferOf(suggestion, car("c1", "Coolray", 15_000), null)).toBe("ask");
    expect(mileageOfferOf(suggestion, car("c1", "Coolray"), null)).toBe("ask");
  });

  it("asks nothing when the car has it already, the car is gone or nothing is suggested", () => {
    expect(mileageOfferOf(suggestion, car("c1", "Coolray", 20_000), null)).toBeNull();
    expect(mileageOfferOf(suggestion, null, null)).toBeNull();
    expect(mileageOfferOf(null, car("c1", "Coolray"), null)).toBeNull();
  });

  it("is saving while the request goes and saved after", () => {
    expect(mileageOfferOf(suggestion, car("c1", "Coolray"), "saving")).toBe("saving");
    expect(mileageOfferOf(suggestion, car("c1", "Coolray", 20_000), "saved")).toBe("saved");
    expect(mileageOfferOf(suggestion, null, "saved")).toBeNull();
  });
});

describe("createAssistantTurns — one new dialog a send", () => {
  it("a send without a dialog opens one; the next waits for it and goes into it", async () => {
    const turns = createAssistantTurns(keys());
    const first = turns.begin();
    const target = await turns.dialogFor(first, null);
    expect(target.kind).toBe("open");
    // «Остановить», and at once the next message.
    turns.stop();
    const second = turns.begin();
    let into: string | null = null;
    void turns.dialogFor(second, null).then((t) => {
      into = t.kind === "dialog" ? t.dialogId : "opened";
    });
    await flush();
    expect(into).toBeNull(); // waits: no second new dialog
    if (target.kind === "open") target.settle("dialog-A");
    await flush();
    expect(into).toBe("dialog-A");
    expect(turns.awaited(first)).toBe(false);
    expect(turns.awaited(second)).toBe(true);
  });

  it("several waiting sends all go into the one opened dialog", async () => {
    const turns = createAssistantTurns(keys());
    const opener = await turns.dialogFor(turns.begin(), null);
    const waits = [turns.begin(), turns.begin(), turns.begin()].map((t) =>
      turns.dialogFor(t, null),
    );
    if (opener.kind === "open") opener.settle("dialog-A");
    const targets = await Promise.all(waits);
    expect(targets).toEqual([
      { kind: "dialog", dialogId: "dialog-A" },
      { kind: "dialog", dialogId: "dialog-A" },
      { kind: "dialog", dialogId: "dialog-A" },
    ]);
  });

  it("a failed opening lets exactly one waiting send open the dialog", async () => {
    const turns = createAssistantTurns(keys());
    const opener = await turns.dialogFor(turns.begin(), null);
    const a = turns.dialogFor(turns.begin(), null);
    const b = turns.dialogFor(turns.begin(), null);
    if (opener.kind === "open") opener.settle(null);
    const first = await a;
    expect(first.kind).toBe("open");
    let second: string | null = null;
    void b.then((t) => {
      second = t.kind === "dialog" ? t.dialogId : "opened";
    });
    await flush();
    expect(second).toBeNull();
    if (first.kind === "open") first.settle("dialog-B");
    await flush();
    expect(second).toBe("dialog-B");
  });

  it("after the opening is over, a send without a stored dialog (gone: 404) opens anew", async () => {
    const turns = createAssistantTurns(keys());
    const opener = await turns.dialogFor(turns.begin(), null);
    if (opener.kind === "open") opener.settle("dialog-A");
    await flush();
    // The device remembered A, then the server said A is gone: nothing stored.
    expect((await turns.dialogFor(turns.begin(), null)).kind).toBe("open");
  });

  it("a remembered dialog is sent into directly", async () => {
    const turns = createAssistantTurns(keys());
    expect(await turns.dialogFor(turns.begin(), "dialog-A")).toEqual({
      kind: "dialog",
      dialogId: "dialog-A",
    });
  });

  it("a new dialog does not wait for the opening of the one before", async () => {
    const turns = createAssistantTurns(keys());
    const before = await turns.dialogFor(turns.begin(), null);
    turns.advance();
    const after = await turns.dialogFor(turns.begin(), null);
    expect(after.kind).toBe("open");
    if (before.kind === "open") before.settle("dialog-old");
  });
});

describe("createAssistantTurns — late answers", () => {
  it("a late answer remembers its dialog only if no later send remembered one", () => {
    const turns = createAssistantTurns(keys());
    const early = turns.begin();
    const late = turns.begin();
    expect(turns.mayRemember(late)).toBe(true);
    expect(turns.mayRemember(early)).toBe(false);
    expect(turns.mayRemember(late)).toBe(true);
  });

  it("in order, each answer remembers", () => {
    const turns = createAssistantTurns(keys());
    const a = turns.begin();
    expect(turns.mayRemember(a)).toBe(true);
    const b = turns.begin();
    expect(turns.mayRemember(b)).toBe(true);
  });
});

describe("createAssistantTurns — answers of a past epoch are dropped", () => {
  it("a reading, a send and a poll begun before a new dialog are not current", () => {
    const turns = createAssistantTurns(keys());
    const reading = turns.begin();
    const send = turns.begin();
    const poll = turns.begin();
    expect([reading, send, poll].every((t) => turns.current(t))).toBe(true);
    turns.advance(); // «Новый диалог», another person, another car
    expect([reading, send, poll].some((t) => turns.current(t))).toBe(false);
    expect(turns.mayRemember(send)).toBe(false);
    expect(turns.current(turns.begin())).toBe(true);
  });

  it("«Остановить» keeps the epoch: the answer is still of this dialog, but not awaited", () => {
    const turns = createAssistantTurns(keys());
    const send = turns.begin();
    turns.stop();
    expect(turns.current(send)).toBe(true);
    expect(turns.awaited(send)).toBe(false);
    expect(turns.mayRemember(send)).toBe(true);
  });
});

describe("createAssistantTurns — the open key after a lost answer (TASK-063.B)", () => {
  it("an opening that failed leaves its key: the next opening resends it, marked resent", async () => {
    const turns = createAssistantTurns(keys());
    const first = await turns.dialogFor(turns.begin(), null);
    expect(first).toMatchObject({ kind: "open", openKey: "key-1", resent: false });
    // The network dropped: no answer, the dialog may exist on the server.
    if (first.kind === "open") first.settle(null);
    const again = await turns.dialogFor(turns.begin(), null);
    expect(again).toMatchObject({ kind: "open", openKey: "key-1", resent: true });
    if (again.kind === "open") again.settle("dialog-A");
    await flush();
    // Named: the next opening (the dialog gone, 404) is another dialog, another key.
    expect(await turns.dialogFor(turns.begin(), null)).toMatchObject({
      kind: "open",
      openKey: "key-2",
      resent: false,
    });
  });

  it("a new epoch has a new key, whatever the old one's opening did", async () => {
    const turns = createAssistantTurns(keys());
    const before = await turns.dialogFor(turns.begin(), null);
    if (before.kind === "open") before.settle(null);
    turns.advance(); // «Новый диалог», sign-in, sign-out, another car
    const after = await turns.dialogFor(turns.begin(), null);
    expect(after).toMatchObject({ openKey: "key-2", resent: false });
    // The old opening naming its dialog late does not move the new epoch's key on.
    if (before.kind === "open") before.settle("dialog-old");
    if (after.kind === "open") after.settle(null);
    const next = await turns.dialogFor(turns.begin(), null);
    expect(next).toMatchObject({ kind: "open", openKey: "key-2", resent: true });
  });
});

/** A clock the test moves by hand, for the loading indicator. */
function handClock() {
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
  return { clock, advanceTo };
}

/** A reading the test answers by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("loadDialog — the reading of a dialog and the loading indicator (TASK-063.B)", () => {
  /** The screen's model: an epoch, the indicator, what is shown; `advance` cancels the indicator's load. */
  function screen() {
    const time = handClock();
    const turns = createAssistantTurns(keys());
    const gate = createLoadingGate(time.clock);
    const shown: string[] = [];
    const failures: unknown[] = [];
    const load = (read: Promise<string>) =>
      loadDialog(
        turns,
        gate,
        () => read,
        (answer) => shown.push(answer),
        (error) => failures.push(error),
      );
    const advance = () => {
      turns.advance();
      gate.cancel();
    };
    return { ...time, turns, gate, shown, failures, load, advance };
  }

  it("«Новый диалог» while the answer is held for the indicator's minimum: the old dialog never shows", async () => {
    const s = screen();
    const read = deferred<string>();
    const done = s.load(read.promise);
    s.advanceTo(400); // the indicator is on screen (after 300 ms)
    expect(s.gate.indicator).toBe(true);
    read.resolve("old dialog");
    await done;
    // Held: the indicator must stay 500 ms.
    expect(s.shown).toEqual([]);
    s.advance(); // «Новый диалог»
    s.advanceTo(1_900);
    expect(s.shown).toEqual([]);
    expect(s.gate.indicator).toBe(false);
  });

  it("the epoch moved on without cancelling: the held answer is still checked when shown", async () => {
    const s = screen();
    const read = deferred<string>();
    const done = s.load(read.promise);
    s.advanceTo(400);
    read.resolve("old dialog");
    await done;
    s.turns.advance(); // only the epoch, not the indicator
    s.advanceTo(1_900);
    expect(s.shown).toEqual([]);
  });

  it("an answer of a past epoch does not cancel the newer load: sign-out shows the guest's dialog", async () => {
    const s = screen();
    const account = deferred<string>();
    const accountDone = s.load(account.promise);
    s.advanceTo(400);
    s.advance(); // signed out
    const guest = deferred<string>();
    const guestDone = s.load(guest.promise);
    // The account's reading comes back late: it is dropped and touches nothing.
    account.resolve("account dialog");
    expect(await accountDone).toBeNull();
    guest.resolve("guest dialog");
    expect(await guestDone).toBe("guest dialog");
    s.advanceTo(2_000);
    expect(s.shown).toEqual(["guest dialog"]);
  });

  it("a failure of a past epoch touches nothing either; one of the current epoch is handed on", async () => {
    const s = screen();
    const old = deferred<string>();
    const oldDone = s.load(old.promise);
    s.advance();
    const now = deferred<string>();
    const nowDone = s.load(now.promise);
    old.reject(new Error("gone"));
    expect(await oldDone).toBeNull();
    expect(s.failures).toEqual([]);
    now.resolve("current");
    await nowDone;
    s.advanceTo(2_000);
    expect(s.shown).toEqual(["current"]);

    const failing = deferred<string>();
    const failingDone = s.load(failing.promise);
    failing.reject(new Error("404"));
    await failingDone;
    s.advanceTo(4_000);
    expect(s.failures).toHaveLength(1);
  });

  it("a quick answer shows at once, without the indicator", async () => {
    const s = screen();
    const read = deferred<string>();
    const done = s.load(read.promise);
    read.resolve("dialog");
    await done;
    expect(s.shown).toEqual(["dialog"]);
    expect(s.gate.indicator).toBe(false);
  });
});
