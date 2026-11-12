import { isApiError } from "@adclub/api-client";
import type {
  AssistantCar,
  AssistantDialogResponse,
  AssistantLimits,
  AssistantReply,
} from "@adclub/contracts";
import type { AiPilotState } from "@adclub/ui-core";
import type { GarageCar } from "../garage/garage";

/**
 * The AI Pilot assistant in the app (TASK-063; SCREENS M-AI-01, M-AI-02;
 * ARCHITECTURE 4.86) — the rules as plain functions, tested without React
 * Native (`assistant-rules.test.ts`).
 *
 * The app decides nothing the server decides: the cards, their marks and
 * prices, the groups of a service, the disclaimer, «недоступен» — all are
 * what `POST /assistant/messages` answered. What is decided here is only
 * how to show it: when the counter of what is left appears, which sheet of
 * M-AI-02 a refusal opens, what the character looks like.
 */

/** The car of the request: a signed-in person's by its id in the account, a guest's by its levels. */
export function assistantCarOf(
  car: GarageCar,
  signedIn: boolean,
): { car: AssistantCar; mileageKm?: number } {
  if (signedIn) return { car: { carId: car.id } };
  const year = car.year === null ? {} : { year: car.year };
  // As the catalog names a car (`vehicleQuery`): a known modification alone, else the levels known.
  const levels: AssistantCar = car.modificationId
    ? { modificationId: car.modificationId, ...year }
    : {
        makeId: car.make.id,
        modelId: car.model.id,
        ...(car.generation ? { generationId: car.generation.id } : {}),
        ...(car.body ? { bodyTypeId: car.body.id } : {}),
        ...(car.engine ? { engineId: car.engine.id } : {}),
        ...(car.transmission ? { transmissionTypeId: car.transmission.id } : {}),
        ...(car.drive ? { driveTypeId: car.drive.id } : {}),
        ...year,
      };
  // A guest's mileage lives on the device; a person's comes from the account's garage.
  return car.mileage ? { car: levels, mileageKm: car.mileage.valueKm } : { car: levels };
}

/**
 * «Осталось пробных вопросов: N» / «Осталось вопросов на сегодня: N» —
 * only when few are left: a guest at one or none, a person at a fifth of
 * the day's dialogs (at least one). `null` — say nothing.
 */
export function assistantCounter(
  limits: AssistantLimits | null,
): { scope: "guest" | "account"; left: number } | null {
  if (!limits) return null;
  const left = Math.max(0, limits.dialogsLeft);
  const threshold = limits.scope === "guest" ? 1 : Math.max(1, Math.floor(limits.dialogsLimit / 5));
  return left <= threshold ? { scope: limits.scope, left } : null;
}

/**
 * What a refusal of a turn means for the screen (M-AI-01, M-AI-02):
 *
 * - `guest_trial` — a guest's trial dialogs are spent (`assistant_dialogs_per_device`):
 *   «Пробные запросы закончились», «Войти» · «Продолжить без этого»;
 * - `guest_budget` — the guests' budget of the day (an answer `unavailable: guest_budget`):
 *   «Пробные запросы временно недоступны», «Войти» · «Понятно»;
 * - `day` — a person's dialogs of the day (`assistant_daily_dialogs_per_user`):
 *   «Лимит на сегодня исчерпан», «В каталог»;
 * - `wait` — too many messages an hour from the address or the account:
 *   «Слишком много вопросов, подождите N мин» (by `Retry-After`);
 * - `dialog_full` — «Диалог получился длинным — начните новый»;
 * - `in_progress` — a turn of this dialog is still running: read the dialog again;
 * - `car_gone` — the car is not in the account any more (another device deleted it);
 * - `dialog_gone` — the dialog is not there (404 with a dialog);
 * - `network` — no answer: «Нужна сеть» / try again;
 * - `other` — anything else.
 */
export type AssistantFailure =
  | { kind: "guest_trial" }
  | { kind: "guest_budget" }
  | { kind: "day" }
  | { kind: "wait"; minutes: number }
  | { kind: "dialog_full" }
  | { kind: "in_progress" }
  | { kind: "car_gone" }
  | { kind: "dialog_gone" }
  | { kind: "network" }
  | { kind: "other" };

function detailsOf(error: { details: unknown }): Record<string, unknown> {
  return typeof error.details === "object" && error.details !== null
    ? (error.details as Record<string, unknown>)
    : {};
}

/** The refusal of `POST /assistant/messages`; `withDialog` — the message named a dialog. */
export function assistantFailureOf(error: unknown, withDialog: boolean): AssistantFailure {
  if (!isApiError(error)) return { kind: "other" };
  switch (error.code) {
    case "RATE_LIMITED": {
      const details = detailsOf(error);
      switch (details.limit) {
        case "assistant_dialogs_per_device":
          return { kind: "guest_trial" };
        case "assistant_daily_dialogs_per_user":
          return { kind: "day" };
        default: {
          const seconds = Number(details.retryAfterSeconds);
          return {
            kind: "wait",
            minutes: Math.max(1, Math.ceil((Number.isFinite(seconds) ? seconds : 60) / 60)),
          };
        }
      }
    }
    case "ASSISTANT_DIALOG_FULL":
      return { kind: "dialog_full" };
    case "ASSISTANT_TURN_IN_PROGRESS":
      return { kind: "in_progress" };
    case "NOT_FOUND":
      return withDialog ? { kind: "dialog_gone" } : { kind: "car_gone" };
    case "NETWORK_ERROR":
    case "SERVICE_UNAVAILABLE":
    case "INTERNAL_ERROR":
    case "INVALID_RESPONSE":
      return { kind: "network" };
    default:
      return error.status >= 500 ? { kind: "network" } : { kind: "other" };
  }
}

/** The sheet of M-AI-02 a failure or an answer opens; `null` — none. */
export type AssistantLimitSheet = "guest_trial" | "guest_budget" | "day";

export function assistantLimitSheetOf(
  outcome: AssistantFailure | AssistantReply,
): AssistantLimitSheet | null {
  if ("role" in outcome) {
    return outcome.kind === "unavailable" && outcome.unavailable?.reason === "guest_budget"
      ? "guest_budget"
      : null;
  }
  return outcome.kind === "guest_trial" || outcome.kind === "guest_budget" || outcome.kind === "day"
    ? outcome.kind
    : null;
}

/**
 * The character of the dialog (DESIGN 6): thinking while a turn runs;
 * after an answer with items — found; after an empty, off-topic or
 * unavailable one — unsure; else waiting.
 */
export function assistantCharacter(pending: boolean, last: AssistantReply | null): AiPilotState {
  if (pending) return "thinking";
  if (!last) return "idle";
  if (last.kind === "unavailable" || last.kind === "off_topic" || last.notFound) return "unsure";
  if (last.cards.length > 0) return "happy";
  return "idle";
}

/** One message of the dialog as the screen draws it. */
export type DialogEntry = AssistantDialogResponse["messages"][number];

/** The quick replies of a question are live only on the last answer of the dialog. */
export function liveQuestionId(entries: readonly DialogEntry[]): string | null {
  const last = entries.at(-1);
  return last && last.role === "assistant" && last.kind === "question" ? last.id : null;
}

/** «Пожаловаться» is under every answer but «недоступен». */
export function canComplain(reply: AssistantReply): boolean {
  return reply.kind !== "unavailable";
}

/**
 * Whose current dialog the device keeps (SCREENS M-AI-01: «хранится только
 * текущий диалог»): a guest's and an account's apart, so signing in opens
 * the account's own dialog and signing out never shows it to a guest.
 */
export interface StoredDialogs {
  guest: { dialogId: string; carId: string } | null;
  account: { accountId: string; dialogId: string; carId: string } | null;
}

export const NO_DIALOGS: StoredDialogs = { guest: null, account: null };

export function parseStoredDialogs(raw: unknown): StoredDialogs {
  if (typeof raw !== "object" || raw === null) return NO_DIALOGS;
  const value = raw as Record<string, unknown>;
  const guest = value.guest as Record<string, unknown> | null | undefined;
  const account = value.account as Record<string, unknown> | null | undefined;
  return {
    guest:
      guest && typeof guest.dialogId === "string" && typeof guest.carId === "string"
        ? { dialogId: guest.dialogId, carId: guest.carId }
        : null,
    account:
      account &&
      typeof account.accountId === "string" &&
      typeof account.dialogId === "string" &&
      typeof account.carId === "string"
        ? { accountId: account.accountId, dialogId: account.dialogId, carId: account.carId }
        : null,
  };
}

/** The current dialog of whoever is using the app now (`null` account — a guest). */
export function currentDialogOf(
  stored: StoredDialogs,
  accountId: string | null,
): { dialogId: string; carId: string } | null {
  if (accountId === null) return stored.guest;
  return stored.account?.accountId === accountId
    ? { dialogId: stored.account.dialogId, carId: stored.account.carId }
    : null;
}

export function withCurrentDialog(
  stored: StoredDialogs,
  accountId: string | null,
  dialog: { dialogId: string; carId: string } | null,
): StoredDialogs {
  if (accountId === null) return { ...stored, guest: dialog };
  return { ...stored, account: dialog ? { accountId, ...dialog } : null };
}
