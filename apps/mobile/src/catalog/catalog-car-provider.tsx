import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { useToast } from "../design-system";
import type { GarageCar } from "../garage/garage";
import { garageErrorText } from "../screens/garage/garage-errors";
import { useGarage } from "../state/garage-provider";
import { useT } from "../state/language";

/**
 * Which car the catalog is asking about (M-CAT-01): always one. The catalog
 * opens only with a car (D-062) — `CatalogGate` decides that with
 * `catalogEntry` and mounts this provider only when there is a car — so a
 * catalog screen never has a «no car» branch and no request can be made
 * without one.
 *
 * The garage owns the cars and which one is the main one; choosing another
 * car in the header of the catalog makes it the main one, because the main
 * car is what filters the catalog (M-GAR-01). Signed in, that is a change of
 * the account's garage (TASK-029.B): the catalog moves to the car once the
 * server has agreed, and a refusal is said and leaves it where it was.
 */
export interface CatalogCarValue {
  /** The car every catalog request names. */
  car: GarageCar;
  chooseCar: (carId: string) => Promise<void>;
}

const CatalogCarContext = createContext<CatalogCarValue | null>(null);

export function CatalogCarProvider({ car, children }: { car: GarageCar; children: ReactNode }) {
  const { makePrimary } = useGarage();
  const toast = useToast();
  const t = useT();
  const chooseCar = useCallback(
    async (carId: string) => {
      if (carId === car.id) return;
      try {
        await makePrimary(carId);
      } catch (error) {
        toast.show(garageErrorText(error, t));
      }
    },
    [car.id, makePrimary, toast, t],
  );
  const value = useMemo<CatalogCarValue>(() => ({ car, chooseCar }), [car, chooseCar]);
  return <CatalogCarContext.Provider value={value}>{children}</CatalogCarContext.Provider>;
}

export function useCatalogCar(): CatalogCarValue {
  const value = useContext(CatalogCarContext);
  if (!value) throw new Error("useCatalogCar must be used inside <CatalogCarProvider>");
  return value;
}
