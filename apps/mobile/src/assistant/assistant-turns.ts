import type { GarageCar } from "../garage/garage";

/**
 * The order of the assistant's requests on the screen (TASK-063.A;
 * ARCHITECTURE 4.86 I976, I987, I988) — plain logic, tested without React
 * Native (`assistant-turns.test.ts`).
 *
 * Three rules:
 *
 * - **An epoch** — the current dialog of the screen, numbered. A new dialog,
 *   another person or another car moves it on (`advance`); whatever was
 *   asked before — a send, a reading of the dialog, a reading after
 *   `ASSISTANT_TURN_IN_PROGRESS`, the limits — is dropped when it comes
 *   (`current`). One check for all of them.
 * - **One send opens at most one dialog.** A send without a dialog opens
 *   one (`dialogFor` → `open`); until its answer names the dialog, every
 *   next send of the same epoch waits for it and goes into that dialog —
 *   also after «Остановить», which stops waiting, not the turn. If the
 *   opening failed, the next send opens the dialog itself.
 * - **A late answer remembers its dialog** only if no later send of the
 *   same epoch has remembered one meanwhile (`mayRemember`).
 */

/** One request of the screen: its epoch, its attempt (what «Остановить» moves on), its order. */
export interface Turn {
  readonly epoch: number;
  readonly attempt: number;
  readonly seq: number;
}

/**
 * Where a send goes: an existing dialog, or a new one it opens and must name
 * (`settle`), sent with the epoch's open key (`openKey`, TASK-063.B).
 */
export type DialogTarget =
  | { kind: "dialog"; dialogId: string }
  | {
      kind: "open";
      openKey: string;
      /** The key went out before with no dialog named: the dialog may hold an exchange not shown. */
      resent: boolean;
      settle: (dialogId: string | null) => void;
    };

export interface AssistantTurns {
  /** A new dialog, another person, another car: what was asked before is dropped. */
  advance(): void;
  /** «Остановить»: the screen stops waiting for the sends in flight. */
  stop(): void;
  /** A request starts now. */
  begin(): Turn;
  /** The request is still of the current dialog of the screen. */
  current(turn: Turn): boolean;
  /** …and the screen still waits for it (not stopped). */
  awaited(turn: Turn): boolean;
  /** The dialog to send into: `stored` — the one the device remembers. */
  dialogFor(turn: Turn, stored: string | null): Promise<DialogTarget>;
  /** May the answer of this request remember its dialog as the current one. */
  mayRemember(turn: Turn): boolean;
}

export function createAssistantTurns(newKey: () => string): AssistantTurns {
  let epoch = 0;
  let attempt = 0;
  let seq = 0;
  // The key the next opening of this epoch is sent with. It stays after an
  // opening that failed — its dialog may exist with no answer having come
  // back (the network dropped), and the server finds it by the key — and is
  // new once an opening has named its dialog, or in a new epoch.
  let openKey = newKey();
  let keySent = false;
  const renewKey = () => {
    openKey = newKey();
    keySent = false;
  };
  // The send of this epoch opening a new dialog, and what it named.
  let opening: { epoch: number; named: Promise<string | null> } | null = null;
  // The latest request whose dialog was remembered, in this epoch.
  let remembered = 0;

  const current = (turn: Turn) => turn.epoch === epoch;

  return {
    advance() {
      epoch += 1;
      attempt += 1;
      opening = null;
      remembered = 0;
      renewKey();
    },
    stop() {
      attempt += 1;
    },
    begin() {
      seq += 1;
      return { epoch, attempt, seq };
    },
    current,
    awaited: (turn) => current(turn) && turn.attempt === attempt,
    async dialogFor(turn, stored) {
      if (stored !== null) return { kind: "dialog", dialogId: stored };
      for (;;) {
        if (opening && opening.epoch === turn.epoch) {
          const named = await opening.named;
          if (named !== null) return { kind: "dialog", dialogId: named };
          // The opening failed (`settle(null)` has let it go): the first waiter opens anew.
          continue;
        }
        let settle!: (dialogId: string | null) => void;
        const named = new Promise<string | null>((resolve) => {
          settle = resolve;
        });
        const mine = { epoch: turn.epoch, named };
        if (turn.epoch === epoch) opening = mine;
        const key = openKey;
        const resent = keySent;
        keySent = true;
        return {
          kind: "open",
          openKey: key,
          resent,
          // Settled either way, the opening is over: the sends waiting hold its
          // promise; a later one goes by the stored dialog (which the answer
          // has remembered, or a 404 has cleared — then it opens anew).
          settle: (dialogId) => {
            settle(dialogId);
            if (opening === mine) opening = null;
            // Named: the key has done its work; the next opening is another dialog.
            if (dialogId !== null && openKey === key) renewKey();
          },
        };
      }
    },
    mayRemember(turn) {
      if (!current(turn) || turn.seq < remembered) return false;
      remembered = turn.seq;
      return true;
    },
  };
}

/** The loading indicator the reading of a dialog goes through (`createLoadingGate`). */
export interface DialogLoadingGate {
  begin(): number;
  settle(ticket: number, show: () => void): void;
}

/**
 * One reading of the dialog through the loading indicator (TASK-063.B;
 * ARCHITECTURE 4.86 I987):
 *
 * - its answer is shown only if the screen is still in the same epoch — when
 *   it comes, and again when the indicator lets it be shown (up to its
 *   minimum later): «Новый диалог» in between drops it;
 * - an answer of another epoch touches nothing — not the indicator either:
 *   whatever the indicator shows now is a newer load's (the epoch moving on
 *   has cancelled this one's, `advance` of the screen);
 * - a failure is handed on (`failed`) under the same two checks.
 *
 * Returns the answer if it is still of the current epoch, else `null`.
 */
export async function loadDialog<Answer>(
  turns: AssistantTurns,
  gate: DialogLoadingGate,
  read: () => Promise<Answer>,
  show: (answer: Answer) => void,
  failed: (error: unknown) => void,
): Promise<Answer | null> {
  const turn = turns.begin();
  const ticket = gate.begin();
  try {
    const answer = await read();
    if (!turns.current(turn)) return null;
    gate.settle(ticket, () => {
      if (turns.current(turn)) show(answer);
    });
    return answer;
  } catch (error) {
    if (!turns.current(turn)) return null;
    gate.settle(ticket, () => {
      if (turns.current(turn)) failed(error);
    });
    return null;
  }
}

/**
 * The car an answer was given for (TASK-063.A): the car of the dialog, not
 * the one in the header. `null` — the dialog's car is not in the garage any
 * more (deleted here or on another device): nothing is written to it, and
 * the cards say «для …» of no car.
 */
export function answerCarOf(
  cars: readonly GarageCar[],
  dialogCarId: string | null,
): GarageCar | null {
  if (dialogCarId === null) return null;
  return cars.find((car) => car.id === dialogCarId) ?? null;
}

/**
 * «Обновить пробег до N км?» under an answer (I980): asked of the answer's
 * car only; `saving` while the request goes; none once the car's mileage is
 * that already or the car is gone.
 */
export function mileageOfferOf(
  suggestion: { km: number } | null,
  car: GarageCar | null,
  state: "saving" | "saved" | null,
): "ask" | "saving" | "saved" | null {
  if (!suggestion || !car) return null;
  if (state) return state;
  return car.mileage?.valueKm === suggestion.km ? null : "ask";
}
