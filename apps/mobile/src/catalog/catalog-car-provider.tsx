import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { GarageCar } from "../garage/garage";
import { useGarage } from "../state/garage-provider";

/**
 * Which car the catalog is asking about (M-CAT-01). The garage owns the
 * cars and which one is the main one; this only holds «Показать без
 * фильтра», which is a state of the screen and **never** touches the
 * garage (TASK-028 requirement 2). Choosing another car in the header does
 * make it the main one — the main car is what filters the catalog
 * (M-GAR-01).
 */
export interface CatalogCarValue {
  /** The car every catalog request names; `null` — none, or the filter is off. */
  car: GarageCar | null;
  /** `true` while «Показать без фильтра» is on. */
  filterOff: boolean;
  showWithoutCar: () => void;
  chooseCar: (carId: string) => void;
}

const CatalogCarContext = createContext<CatalogCarValue | null>(null);

export function CatalogCarProvider({ children }: { children: ReactNode }) {
  const { primary, makePrimary } = useGarage();
  const [filterOff, setFilterOff] = useState(false);

  const showWithoutCar = useCallback(() => setFilterOff(true), []);
  const chooseCar = useCallback(
    (carId: string) => {
      makePrimary(carId);
      setFilterOff(false);
    },
    [makePrimary],
  );

  const value = useMemo<CatalogCarValue>(
    () => ({ car: filterOff ? null : primary, filterOff, showWithoutCar, chooseCar }),
    [filterOff, primary, showWithoutCar, chooseCar],
  );

  return <CatalogCarContext.Provider value={value}>{children}</CatalogCarContext.Provider>;
}

export function useCatalogCar(): CatalogCarValue {
  const value = useContext(CatalogCarContext);
  if (!value) throw new Error("useCatalogCar must be used inside <CatalogCarProvider>");
  return value;
}
