import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { GarageCar } from "../garage/garage";
import { useGarage } from "../state/garage-provider";

/**
 * Which car the catalog is asking about (M-CAT-01): always one. The catalog
 * opens only with a car (D-062) — `CatalogGate` decides that with
 * `catalogEntry` and mounts this provider only when there is a car — so a
 * catalog screen never has a «no car» branch and no request can be made
 * without one.
 *
 * The garage owns the cars and which one is the main one; choosing another
 * car in the header of the catalog makes it the main one, because the main
 * car is what filters the catalog (M-GAR-01).
 */
export interface CatalogCarValue {
  /** The car every catalog request names. */
  car: GarageCar;
  chooseCar: (carId: string) => void;
}

const CatalogCarContext = createContext<CatalogCarValue | null>(null);

export function CatalogCarProvider({ car, children }: { car: GarageCar; children: ReactNode }) {
  const { makePrimary } = useGarage();
  const value = useMemo<CatalogCarValue>(
    () => ({ car, chooseCar: makePrimary }),
    [car, makePrimary],
  );
  return <CatalogCarContext.Provider value={value}>{children}</CatalogCarContext.Provider>;
}

export function useCatalogCar(): CatalogCarValue {
  const value = useContext(CatalogCarContext);
  if (!value) throw new Error("useCatalogCar must be used inside <CatalogCarProvider>");
  return value;
}
