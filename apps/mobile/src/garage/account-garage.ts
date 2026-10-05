import type {
  AccountCar,
  AddGarageCarBody,
  SaveGarageCarBody,
  TransferGarageBody,
  TransferGarageResponse,
} from "@adclub/contracts";
import { isApiError } from "@adclub/api-client";
import {
  fromAccountCar,
  garageStateFromAccountCars,
  toSaveBody,
  toTransferBody,
} from "./account-cars";
import {
  INITIAL_GARAGE,
  parseGarage,
  removeCar,
  setPrimary,
  type GarageCar,
  type GarageState,
} from "./garage";

/**
 * The garage of a signed-in person lives in the account (TASK-029.B,
 * ARCHITECTURE 4.46): the account is the source of truth, and the device
 * keeps a **copy** of it so the garage, the catalog header and the catalog
 * open at once and work without a network.
 *
 * The rules, free of React Native so they are tested as they are:
 *
 * - **What the app shows.** A guest — the guest garage of the device. Signed
 *   in — the copy, when it is this account's; until the first sync of this
 *   sign-in it is still the guest garage, which that sync transfers.
 * - **A change is done when the server said so.** `add`, `update`,
 *   `makePrimary`, `remove` call the server first; only its answer changes
 *   the copy, and a refusal changes nothing (the caller shows it). After each
 *   one the copy is synced again, so what another device did meanwhile shows
 *   too.
 * - **A sync** lists the account's garage — or, while the guest garage still
 *   holds cars (a first sign-in, a sign-in whose transfer failed), transfers
 *   them first (idempotent, no duplicates, I425) and empties the guest
 *   garage: from then on those cars live in the account.
 * - **No stale answer wins.** A sync that was asked while a change was in
 *   flight may have read the garage before the change; its answer is thrown
 *   away (`epoch`) and the change's own sync reads it again.
 * - **The copy belongs to the session** (`accountId` in it): a sign-in with
 *   another number never shows the previous account's cars, and the session
 *   store clears it on sign-out and `SESSION_ENDED`.
 */

export interface AccountGarageCopy {
  version: 1;
  accountId: string;
  garage: GarageState;
}

export function parseAccountGarageCopy(raw: unknown): AccountGarageCopy | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (value.version !== 1 || typeof value.accountId !== "string") return null;
  const garage = parseGarage(value.garage);
  return garage ? { version: 1, accountId: value.accountId, garage } : null;
}

/** The garage the app shows: the copy of this account's, or the guest garage of the device. */
export function visibleGarage(
  accountId: string | null,
  copy: AccountGarageCopy | null,
  guest: GarageState,
): GarageState {
  if (accountId !== null && copy?.accountId === accountId) return copy.garage;
  return guest;
}

/** The car an answer of the server added or changed, put into the copy (again harmless). */
export function withAccountCar(garage: GarageState, answer: AccountCar): GarageState {
  const car = fromAccountCar(answer);
  const known = garage.cars.some((item) => item.id === car.id);
  const cars = known
    ? garage.cars.map((item) => (item.id === car.id ? car : item))
    : [...garage.cars, car];
  const primaryId = answer.isPrimary ? car.id : (garage.primaryId ?? car.id);
  return { version: 1, cars, primaryId };
}

export interface AccountGarageApi {
  list(): Promise<readonly AccountCar[]>;
  add(body: AddGarageCarBody): Promise<AccountCar>;
  update(carId: string, body: SaveGarageCarBody): Promise<AccountCar>;
  remove(carId: string): Promise<void>;
  makePrimary(carId: string): Promise<AccountCar>;
  transfer(body: TransferGarageBody): Promise<TransferGarageResponse>;
}

/** A value kept on the device — `DeviceStore` without its subscription. */
export interface ValueStore<T> {
  get(): T;
  set(value: T): void;
}

export interface AccountGarageDeps {
  api: AccountGarageApi;
  copy: ValueStore<AccountGarageCopy | null>;
  guest: ValueStore<GarageState>;
  /** The signed-in account now; `null` — a guest. */
  accountId: () => string | null;
}

export type SyncResult =
  /** The copy is the account's garage as the server just said; `transferred` — guest cars new to it. */
  | { kind: "synced"; transferred: number }
  /** A change happened meanwhile: this answer was dropped, the change's own sync follows. */
  | { kind: "stale" }
  /** Nobody is signed in (or someone else is by now). */
  | { kind: "skipped" }
  /** No answer: the copy stays as it was. */
  | { kind: "failed"; error: unknown };

export interface AccountGarage {
  /** Reads the account's garage into the copy (transferring the guest garage first, if it has cars). */
  sync(): Promise<SyncResult>;
  /** `idempotencyKey` — one per «Сохранить» screen: a repeat after a lost answer adds nothing. */
  add(car: GarageCar, idempotencyKey: string): Promise<GarageCar>;
  update(car: GarageCar): Promise<GarageCar>;
  makePrimary(carId: string): Promise<void>;
  remove(carId: string): Promise<void>;
}

export function createAccountGarage(deps: AccountGarageDeps): AccountGarage {
  // Bumped when a change starts and when it has been applied: a sync whose
  // answer arrives under another epoch read the garage around a change.
  let epoch = 0;
  let inflight: { epoch: number; promise: Promise<SyncResult> } | null = null;

  function write(accountId: string, garage: GarageState): void {
    if (deps.accountId() !== accountId) return;
    deps.copy.set({ version: 1, accountId, garage });
  }

  function copyOf(accountId: string): GarageState {
    const copy = deps.copy.get();
    return copy?.accountId === accountId ? copy.garage : INITIAL_GARAGE;
  }

  async function syncOnce(): Promise<SyncResult> {
    const accountId = deps.accountId();
    if (accountId === null) return { kind: "skipped" };
    const started = epoch;
    const guest = deps.guest.get();
    try {
      if (guest.cars.length > 0) {
        const answer = await deps.api.transfer(toTransferBody(guest));
        if (deps.accountId() !== accountId) return { kind: "skipped" };
        // The cars are the account's now; the guest garage is not where they live.
        deps.guest.set(INITIAL_GARAGE);
        if (started !== epoch) return { kind: "stale" };
        write(accountId, garageStateFromAccountCars(answer.cars));
        return { kind: "synced", transferred: answer.transferred };
      }
      const cars = await deps.api.list();
      if (deps.accountId() !== accountId) return { kind: "skipped" };
      if (started !== epoch) return { kind: "stale" };
      write(accountId, garageStateFromAccountCars(cars));
      return { kind: "synced", transferred: 0 };
    } catch (error) {
      return { kind: "failed", error };
    }
  }

  function sync(): Promise<SyncResult> {
    // One read at a time — unless a change has happened since it began.
    if (inflight && inflight.epoch === epoch) return inflight.promise;
    const entry = { epoch, promise: syncOnce() };
    inflight = entry;
    void entry.promise.finally(() => {
      if (inflight === entry) inflight = null;
    });
    return entry.promise;
  }

  async function change<T>(
    call: () => Promise<T>,
    apply: (garage: GarageState, answer: T) => GarageState,
  ): Promise<T> {
    const accountId = deps.accountId();
    if (accountId === null) throw new Error("The account garage needs a signed-in session");
    // The guest cars of this sign-in go first, so a change never lands in a
    // garage that is about to receive them.
    if (deps.guest.get().cars.length > 0) {
      const transfer = await sync();
      if (transfer.kind === "failed") throw transfer.error;
    }
    epoch += 1;
    try {
      const answer = await call();
      write(accountId, apply(copyOf(accountId), answer));
      return answer;
    } finally {
      epoch += 1;
      // The server's own word on the whole garage, whatever happened above.
      void sync();
    }
  }

  return {
    sync,
    add: async (car, idempotencyKey) =>
      fromAccountCar(
        await change(
          () => deps.api.add({ ...toSaveBody(car), idempotencyKey }),
          (garage, answer) => withAccountCar(garage, answer),
        ),
      ),
    update: async (car) =>
      fromAccountCar(
        await change(
          () => deps.api.update(car.id, toSaveBody(car)),
          (garage, answer) => withAccountCar(garage, answer),
        ),
      ),
    makePrimary: async (carId) => {
      await change(
        () => deps.api.makePrimary(carId),
        (garage, answer) => setPrimary(withAccountCar(garage, answer), answer.id),
      );
    },
    remove: async (carId) => {
      await change(
        async () => {
          try {
            await deps.api.remove(carId);
          } catch (error) {
            // Already gone — removed on another device, or by a repeat of
            // this very request whose answer was lost: the wish is fulfilled.
            if (!(isApiError(error) && error.status === 404)) throw error;
          }
        },
        (garage) => removeCar(garage, carId),
      );
    },
  };
}
