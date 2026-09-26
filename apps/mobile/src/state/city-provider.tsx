import type { ClientCity } from "@adclub/contracts";
import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { reconcileCity, selectionOf, type CitySelection, type CityState } from "./city";
import { cityStore } from "./stores";

/**
 * The city of the app — one value for the whole app (SCREENS 5.1): the
 * catalog header and the profile read it here and change it here, and it is
 * kept on the device (TASK-029 also puts it in the account).
 */
export interface CityContextValue {
  selection: CitySelection;
  /** Whether the user has already chosen a city (the first run asks once). */
  chosen: boolean;
  /** Whether geolocation has ever been used — it never runs by itself again. */
  detected: boolean;
  /** `null` — "Весь Казахстан". */
  choose: (city: ClientCity | null, options?: { detected?: boolean }) => void;
  /** Brings the stored city in step with a freshly loaded list (rename, archive). */
  reconcile: (cities: readonly ClientCity[]) => void;
}

const CityContext = createContext<CityContextValue | null>(null);

export function CityProvider({ children }: { children: ReactNode }) {
  const state = useSyncExternalStore(cityStore.subscribe, cityStore.get);

  const choose = useCallback((city: ClientCity | null, options?: { detected?: boolean }) => {
    const current = cityStore.get();
    cityStore.set({
      selection: city ? selectionOf(city) : { kind: "all" },
      chosen: true,
      detected: options?.detected ?? current.detected,
    });
  }, []);

  const reconcile = useCallback((cities: readonly ClientCity[]) => {
    if (cities.length === 0) return;
    const current = cityStore.get();
    const next: CityState = reconcileCity(current, cities);
    if (next !== current) cityStore.set(next);
  }, []);

  const value = useMemo<CityContextValue>(
    () => ({
      selection: state.selection,
      chosen: state.chosen,
      detected: state.detected,
      choose,
      reconcile,
    }),
    [state, choose, reconcile],
  );

  return <CityContext.Provider value={value}>{children}</CityContext.Provider>;
}

export function useCity(): CityContextValue {
  const value = useContext(CityContext);
  if (!value) throw new Error("useCity must be used inside <CityProvider>");
  return value;
}
