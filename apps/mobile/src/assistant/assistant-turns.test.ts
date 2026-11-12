import { describe, expect, it } from "vitest";
import type { GarageCar } from "../garage/garage";
import { answerCarOf, createAssistantTurns, mileageOfferOf } from "./assistant-turns";

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
    const turns = createAssistantTurns();
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
    const turns = createAssistantTurns();
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
    const turns = createAssistantTurns();
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
    const turns = createAssistantTurns();
    const opener = await turns.dialogFor(turns.begin(), null);
    if (opener.kind === "open") opener.settle("dialog-A");
    await flush();
    // The device remembered A, then the server said A is gone: nothing stored.
    expect((await turns.dialogFor(turns.begin(), null)).kind).toBe("open");
  });

  it("a remembered dialog is sent into directly", async () => {
    const turns = createAssistantTurns();
    expect(await turns.dialogFor(turns.begin(), "dialog-A")).toEqual({
      kind: "dialog",
      dialogId: "dialog-A",
    });
  });

  it("a new dialog does not wait for the opening of the one before", async () => {
    const turns = createAssistantTurns();
    const before = await turns.dialogFor(turns.begin(), null);
    turns.advance();
    const after = await turns.dialogFor(turns.begin(), null);
    expect(after.kind).toBe("open");
    if (before.kind === "open") before.settle("dialog-old");
  });
});

describe("createAssistantTurns — late answers", () => {
  it("a late answer remembers its dialog only if no later send remembered one", () => {
    const turns = createAssistantTurns();
    const early = turns.begin();
    const late = turns.begin();
    expect(turns.mayRemember(late)).toBe(true);
    expect(turns.mayRemember(early)).toBe(false);
    expect(turns.mayRemember(late)).toBe(true);
  });

  it("in order, each answer remembers", () => {
    const turns = createAssistantTurns();
    const a = turns.begin();
    expect(turns.mayRemember(a)).toBe(true);
    const b = turns.begin();
    expect(turns.mayRemember(b)).toBe(true);
  });
});

describe("createAssistantTurns — answers of a past epoch are dropped", () => {
  it("a reading, a send and a poll begun before a new dialog are not current", () => {
    const turns = createAssistantTurns();
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
    const turns = createAssistantTurns();
    const send = turns.begin();
    turns.stop();
    expect(turns.current(send)).toBe(true);
    expect(turns.awaited(send)).toBe(false);
    expect(turns.mayRemember(send)).toBe(true);
  });
});
