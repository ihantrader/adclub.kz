import { ApiError } from "@adclub/api-client";
import { rateLimitNameSchema, type AssistantReply } from "@adclub/contracts";
import { describe, expect, it } from "vitest";
import type { GarageCar } from "../garage/garage";
import {
  assistantCarOf,
  assistantCharacter,
  assistantCounter,
  assistantFailureOf,
  assistantLimitSheetOf,
  canComplain,
  currentDialogOf,
  liveQuestionId,
  NO_DIALOGS,
  parseStoredDialogs,
  withCurrentDialog,
  type DialogEntry,
} from "./assistant-rules";

function apiError(status: number, code: string, details?: unknown) {
  return new ApiError({ status, code: code as never, message: code, details, retryable: false });
}

function car(overrides: Partial<GarageCar> = {}): GarageCar {
  return {
    id: "car-1",
    make: { id: "make-geely", label: "Geely" },
    model: { id: "model-coolray", label: "Coolray" },
    year: 2024,
    generation: null,
    body: null,
    engine: { id: "engine-jlh", label: "JLH-3G15TD" },
    transmission: null,
    drive: null,
    modificationId: null,
    color: null,
    vin: "L6T7844Z0RN001234",
    plate: "777ABC02",
    document: null,
    mileage: null,
    addedAt: "2026-11-12T10:00:00.000Z",
    ...overrides,
  };
}

function reply(overrides: Partial<AssistantReply> = {}): AssistantReply {
  return {
    id: "m-1",
    role: "assistant",
    createdAt: "2026-11-12T10:00:00.000Z",
    kind: "answer",
    intent: "pick_by_params",
    text: "Вот что подойдёт",
    question: null,
    cards: [],
    groups: [],
    total: null,
    orderEachItem: false,
    notOnPlatform: [],
    disclaimer: null,
    mileageSuggestion: null,
    notFound: false,
    unavailable: null,
    ...overrides,
  };
}

const limits = (scope: "guest" | "account", dialogsLeft: number, dialogsLimit: number) => ({
  scope,
  dialogsLeft,
  dialogsLimit,
  turnsLeft: null,
  turnsLimit: 8,
});

describe("the counter of what is left (M-AI-01)", () => {
  it("a guest: only at one trial dialog or none", () => {
    expect(assistantCounter(limits("guest", 3, 3))).toBeNull();
    expect(assistantCounter(limits("guest", 2, 3))).toBeNull();
    expect(assistantCounter(limits("guest", 1, 3))).toEqual({ scope: "guest", left: 1 });
    expect(assistantCounter(limits("guest", 0, 3))).toEqual({ scope: "guest", left: 0 });
  });

  it("a person: at a fifth of the day's dialogs, at least one", () => {
    expect(assistantCounter(limits("account", 5, 20))).toBeNull();
    expect(assistantCounter(limits("account", 4, 20))).toEqual({ scope: "account", left: 4 });
    expect(assistantCounter(limits("account", 0, 20))).toEqual({ scope: "account", left: 0 });
    // ⌊3 / 5⌋ = 0 — still one.
    expect(assistantCounter(limits("account", 2, 3))).toBeNull();
    expect(assistantCounter(limits("account", 1, 3))).toEqual({ scope: "account", left: 1 });
    expect(assistantCounter(limits("account", 2, 10))).toEqual({ scope: "account", left: 2 });
    expect(assistantCounter(limits("account", 3, 10))).toBeNull();
  });

  it("nothing known — nothing said; a negative count is none", () => {
    expect(assistantCounter(null)).toBeNull();
    expect(assistantCounter(limits("guest", -1, 3))).toEqual({ scope: "guest", left: 0 });
  });
});

describe("the sheet of M-AI-02 a refusal opens", () => {
  it("knows every limit name the server can send", () => {
    const sheetOf = (limit: string, retryAfterSeconds = 125) =>
      assistantLimitSheetOf(
        assistantFailureOf(apiError(429, "RATE_LIMITED", { limit, retryAfterSeconds }), false),
      );
    for (const limit of rateLimitNameSchema.options) {
      const sheet = sheetOf(limit);
      if (limit === "assistant_dialogs_per_device") expect(sheet, limit).toBe("guest_trial");
      else if (limit === "assistant_daily_dialogs_per_user") expect(sheet, limit).toBe("day");
      // Any other — the messages of an hour, of an address or an account: wait, no sheet.
      else expect(sheet, limit).toBeNull();
    }
  });

  it("an address or an account an hour: «подождите N мин» by Retry-After", () => {
    for (const limit of ["assistant_guest_per_ip", "assistant_messages_per_account"]) {
      expect(
        assistantFailureOf(apiError(429, "RATE_LIMITED", { limit, retryAfterSeconds: 125 }), true),
      ).toEqual({ kind: "wait", minutes: 3 });
      expect(
        assistantFailureOf(apiError(429, "RATE_LIMITED", { limit, retryAfterSeconds: 10 }), true),
      ).toEqual({ kind: "wait", minutes: 1 });
    }
    expect(assistantFailureOf(apiError(429, "RATE_LIMITED"), true)).toEqual({
      kind: "wait",
      minutes: 1,
    });
  });

  it("the guests' budget comes as an answer, not a refusal", () => {
    expect(
      assistantLimitSheetOf(
        reply({ kind: "unavailable", unavailable: { reason: "guest_budget" } }),
      ),
    ).toBe("guest_budget");
    expect(
      assistantLimitSheetOf(reply({ kind: "unavailable", unavailable: { reason: "provider" } })),
    ).toBeNull();
    expect(
      assistantLimitSheetOf(reply({ kind: "unavailable", unavailable: { reason: "budget" } })),
    ).toBeNull();
    expect(assistantLimitSheetOf(reply())).toBeNull();
  });

  it("the other refusals of a turn", () => {
    expect(assistantFailureOf(apiError(409, "ASSISTANT_DIALOG_FULL"), true)).toEqual({
      kind: "dialog_full",
    });
    expect(assistantFailureOf(apiError(409, "ASSISTANT_TURN_IN_PROGRESS"), true)).toEqual({
      kind: "in_progress",
    });
    expect(assistantFailureOf(apiError(404, "NOT_FOUND"), true)).toEqual({ kind: "dialog_gone" });
    expect(assistantFailureOf(apiError(404, "NOT_FOUND"), false)).toEqual({ kind: "car_gone" });
    expect(assistantFailureOf(apiError(0, "NETWORK_ERROR"), true)).toEqual({ kind: "network" });
    expect(assistantFailureOf(apiError(502, "SOMETHING"), true)).toEqual({ kind: "network" });
    expect(assistantFailureOf(apiError(400, "VALIDATION_ERROR"), true)).toEqual({ kind: "other" });
    expect(assistantFailureOf(new Error("boom"), true)).toEqual({ kind: "other" });
    for (const kind of ["dialog_full", "in_progress", "network", "other"] as const) {
      expect(assistantLimitSheetOf({ kind })).toBeNull();
    }
  });
});

describe("the car a message names", () => {
  it("a signed-in person: the account's car by its id, no levels and no mileage", () => {
    expect(assistantCarOf(car({ mileage: mileage(45_200) }), true)).toEqual({
      car: { carId: "car-1" },
    });
  });

  it("a guest: what is known — the levels, never the VIN or the plate — and the device's mileage", () => {
    const sent = assistantCarOf(car({ mileage: mileage(45_200) }), false);
    expect(sent).toEqual({
      car: { makeId: "make-geely", modelId: "model-coolray", engineId: "engine-jlh", year: 2024 },
      mileageKm: 45_200,
    });
    expect(JSON.stringify(sent)).not.toMatch(/L6T7|777ABC/u);
    // Saved with «Сохранить так»: no engine, no year — only what there is.
    expect(assistantCarOf(car({ engine: null, year: null }), false)).toEqual({
      car: { makeId: "make-geely", modelId: "model-coolray" },
    });
    // A known modification alone, as the catalog names it.
    expect(assistantCarOf(car({ modificationId: "mod-1" }), false)).toEqual({
      car: { modificationId: "mod-1", year: 2024 },
    });
  });
});

function mileage(valueKm: number) {
  return { valueKm, source: "text" as const, recordedAt: "2026-11-01T10:00:00.000Z" };
}

describe("how the dialog looks", () => {
  it("the character: thinking, found, unsure, waiting", () => {
    const card = { id: "i-1" } as AssistantReply["cards"][number];
    expect(assistantCharacter(true, reply({ cards: [card] }))).toBe("thinking");
    expect(assistantCharacter(false, null)).toBe("idle");
    expect(assistantCharacter(false, reply({ cards: [card] }))).toBe("happy");
    expect(assistantCharacter(false, reply({ notFound: true }))).toBe("unsure");
    expect(assistantCharacter(false, reply({ kind: "off_topic" }))).toBe("unsure");
    expect(assistantCharacter(false, reply({ kind: "unavailable" }))).toBe("unsure");
    expect(assistantCharacter(false, reply({ kind: "question" }))).toBe("idle");
  });

  it("only the last question takes a quick reply; every answer but «недоступен» takes a complaint", () => {
    const user = (id: string): DialogEntry => ({
      id,
      role: "user",
      createdAt: "2026-11-12T10:00:00.000Z",
      text: "Нужно масло",
    });
    const question = reply({ id: "q-1", kind: "question" });
    expect(liveQuestionId([user("u-1"), question])).toBe("q-1");
    expect(liveQuestionId([user("u-1"), question, user("u-2"), reply({ id: "a-1" })])).toBeNull();
    expect(liveQuestionId([user("u-1")])).toBeNull();
    expect(liveQuestionId([])).toBeNull();
    expect(canComplain(reply())).toBe(true);
    expect(canComplain(reply({ kind: "off_topic" }))).toBe(true);
    expect(canComplain(reply({ kind: "unavailable" }))).toBe(false);
  });
});

describe("the current dialog on the device", () => {
  const guest = { dialogId: "d-guest", carId: "car-1" };
  const own = { dialogId: "d-acc", carId: "car-9" };

  it("a guest's and an account's apart", () => {
    let stored = withCurrentDialog(NO_DIALOGS, null, guest);
    stored = withCurrentDialog(stored, "acc-1", own);
    expect(currentDialogOf(stored, null)).toEqual(guest);
    expect(currentDialogOf(stored, "acc-1")).toEqual(own);
    // Another account never sees this one's dialog.
    expect(currentDialogOf(stored, "acc-2")).toBeNull();
    expect(currentDialogOf(withCurrentDialog(stored, "acc-1", null), "acc-1")).toBeNull();
    expect(currentDialogOf(withCurrentDialog(stored, "acc-1", null), null)).toEqual(guest);
  });

  it("reads back only what it wrote", () => {
    const stored = withCurrentDialog(withCurrentDialog(NO_DIALOGS, null, guest), "acc-1", own);
    expect(parseStoredDialogs(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
    expect(parseStoredDialogs(null)).toEqual(NO_DIALOGS);
    expect(parseStoredDialogs("x")).toEqual(NO_DIALOGS);
    expect(parseStoredDialogs({ guest: { dialogId: 1 }, account: { dialogId: "d" } })).toEqual(
      NO_DIALOGS,
    );
  });
});
