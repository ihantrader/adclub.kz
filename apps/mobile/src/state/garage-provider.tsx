import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
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
import { garageStore } from "./stores";

/**
 * The garage of the app — one value for the whole app (SCREENS M-GAR-01):
 * the garage tab keeps the cars here and the catalog reads the main one
 * here. Kept on the device; TASK-029 merges it into the account.
 */
export interface GarageContextValue {
  state: GarageState;
  cars: GarageCar[];
  /** The car the catalog filters by; `null` — the garage is empty. */
  primary: GarageCar | null;
  /** A car of the garage that is the same as this one, if there is one. */
  duplicateOf: (car: GarageCar) => GarageCar | undefined;
  add: (car: GarageCar) => void;
  update: (car: GarageCar) => void;
  remove: (carId: string) => void;
  makePrimary: (carId: string) => void;
  /** An id for a car about to be added. */
  nextId: () => string;
}

const GarageContext = createContext<GarageContextValue | null>(null);

export function GarageProvider({ children }: { children: ReactNode }) {
  const state = useSyncExternalStore(garageStore.subscribe, garageStore.get);

  const add = useCallback((car: GarageCar) => garageStore.set(addCar(garageStore.get(), car)), []);
  const update = useCallback(
    (car: GarageCar) => garageStore.set(replaceCar(garageStore.get(), car)),
    [],
  );
  const remove = useCallback(
    (carId: string) => garageStore.set(removeCar(garageStore.get(), carId)),
    [],
  );
  const makePrimary = useCallback(
    (carId: string) => garageStore.set(setPrimary(garageStore.get(), carId)),
    [],
  );
  const duplicateOf = useCallback((car: GarageCar) => findDuplicate(garageStore.get(), car), []);

  const value = useMemo<GarageContextValue>(
    () => ({
      state,
      cars: state.cars,
      primary: primaryCar(state),
      duplicateOf,
      add,
      update,
      remove,
      makePrimary,
      nextId: () => newCarId(Date.now()),
    }),
    [state, duplicateOf, add, update, remove, makePrimary],
  );

  return <GarageContext.Provider value={value}>{children}</GarageContext.Provider>;
}

export function useGarage(): GarageContextValue {
  const value = useContext(GarageContext);
  if (!value) throw new Error("useGarage must be used inside <GarageProvider>");
  return value;
}
