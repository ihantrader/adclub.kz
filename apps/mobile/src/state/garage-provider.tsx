import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { visibleGarage, type SyncResult } from "../garage/account-garage";
import {
  addCar,
  findDuplicate,
  newCarId,
  primaryCar,
  removeCar,
  replaceCar,
  setPrimary,
  type GarageCar,
  type GarageState,
} from "../garage/garage";
import { withGuestMileage, type MileageReading } from "../garage/mileage";
import { accountGarage } from "../services/account-garage";
import { accountGarageStore, garageStore, sessionStore } from "./stores";

/**
 * The garage of the app — one value for the whole app (SCREENS M-GAR-01):
 * the garage tab keeps the cars here and the catalog reads the main one
 * here.
 *
 * A guest's garage lives on the device (TASK-028). A signed-in person's
 * lives in the account (TASK-029.B, ARCHITECTURE 4.46): what is shown is
 * the device's copy of it, and every change goes to the server first — the
 * promise settles when the server has answered, and a refusal rejects it
 * and changes nothing. A guest's changes settle at once.
 */
export interface GarageContextValue {
  state: GarageState;
  cars: GarageCar[];
  /** The car the catalog filters by; `null` — the garage is empty. */
  primary: GarageCar | null;
  /** Signed in: the garage is the account's, and changing it needs the network. */
  remote: boolean;
  /** A car of the garage that is the same as this one, if there is one (as shown now). */
  duplicateOf: (car: GarageCar) => GarageCar | undefined;
  /** `idempotencyKey` — one per adding screen, so a repeat after a lost answer adds nothing. */
  add: (car: GarageCar, idempotencyKey: string) => Promise<GarageCar>;
  update: (car: GarageCar) => Promise<GarageCar>;
  remove: (carId: string) => Promise<void>;
  makePrimary: (carId: string) => Promise<void>;
  /**
   * A reading of the mileage the person confirmed (TASK-058): the account's
   * car on the server, a guest's on the device — the same rule; a lower one
   * without `confirmLower` rejects with `GARAGE_MILEAGE_LOWER`.
   */
  recordMileage: (carId: string, reading: MileageReading, confirmLower: boolean) => Promise<void>;
  /** Reads the account's garage again (signed in); a guest has nothing to read. */
  sync: () => Promise<SyncResult>;
  /** An id for a car about to be added. */
  nextId: () => string;
}

const GarageContext = createContext<GarageContextValue | null>(null);

function signedInAccount(): string | null {
  const session = sessionStore.get();
  return session.status === "signed_in" ? session.session.accountId : null;
}

/** The garage as it is shown right now — read from the stores, never from a render. */
function shownGarage(): GarageState {
  return visibleGarage(signedInAccount(), accountGarageStore.get(), garageStore.get());
}

export function GarageProvider({ children }: { children: ReactNode }) {
  const session = useSyncExternalStore(sessionStore.subscribe, sessionStore.get);
  const copy = useSyncExternalStore(accountGarageStore.subscribe, accountGarageStore.get);
  const guest = useSyncExternalStore(garageStore.subscribe, garageStore.get);
  const accountId = session.status === "signed_in" ? session.session.accountId : null;
  const state = visibleGarage(accountId, copy, guest);
  const remote = accountId !== null;

  const add = useCallback(async (car: GarageCar, idempotencyKey: string) => {
    if (signedInAccount() !== null) return accountGarage.add(car, idempotencyKey);
    garageStore.set(addCar(garageStore.get(), car));
    return car;
  }, []);
  const update = useCallback(async (car: GarageCar) => {
    if (signedInAccount() !== null) return accountGarage.update(car);
    garageStore.set(replaceCar(garageStore.get(), car));
    return car;
  }, []);
  const remove = useCallback(async (carId: string) => {
    if (signedInAccount() !== null) return accountGarage.remove(carId);
    garageStore.set(removeCar(garageStore.get(), carId));
  }, []);
  const makePrimary = useCallback(async (carId: string) => {
    if (signedInAccount() !== null) return accountGarage.makePrimary(carId);
    garageStore.set(setPrimary(garageStore.get(), carId));
  }, []);
  const recordMileage = useCallback(
    async (carId: string, reading: MileageReading, confirmLower: boolean) => {
      if (signedInAccount() !== null) {
        await accountGarage.recordMileage(carId, {
          valueKm: reading.valueKm,
          source: reading.source,
          ...(reading.source === "photo"
            ? {
                recognizedKm: reading.recognizedKm ?? null,
                recognitionId: reading.recognitionId ?? null,
              }
            : {}),
          ...(confirmLower ? { confirmLower: true } : {}),
        });
        return;
      }
      garageStore.set(
        withGuestMileage(garageStore.get(), carId, reading, confirmLower, new Date()),
      );
    },
    [],
  );
  const duplicateOf = useCallback((car: GarageCar) => findDuplicate(shownGarage(), car), []);
  const sync = useCallback(() => accountGarage.sync(), []);

  const value = useMemo<GarageContextValue>(
    () => ({
      state,
      cars: state.cars,
      primary: primaryCar(state),
      remote,
      duplicateOf,
      add,
      update,
      remove,
      makePrimary,
      recordMileage,
      sync,
      nextId: () => newCarId(Date.now()),
    }),
    [state, remote, duplicateOf, add, update, remove, makePrimary, recordMileage, sync],
  );

  return <GarageContext.Provider value={value}>{children}</GarageContext.Provider>;
}

export function useGarage(): GarageContextValue {
  const value = useContext(GarageContext);
  if (!value) throw new Error("useGarage must be used inside <GarageProvider>");
  return value;
}
