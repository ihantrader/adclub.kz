/**
 * «Open the catalog for this car» from outside a screen (TASK-069): a push of
 * a reminder (P-REM-01/02) names the car it is about, and the catalog's home
 * shows it in its header. The catalog tab takes the request and makes the
 * car the main one — the header's own way of choosing a car (M-CAT-01).
 *
 * A push may open the app from nothing (TASK-069.A): the garage is not read
 * yet, and the car is not in it. The request is then kept until the garage
 * has loaded — found, it is applied; still not there (the car was deleted),
 * it is dropped without a word. The decision is `catalogCarDecision`.
 */

export type CatalogCarDecision =
  /** The car is in the garage: it becomes the car of the header. */
  | "apply"
  /** The garage is still loading: the request waits. */
  | "wait"
  /** The garage has loaded without the car: the request is dropped silently. */
  | "drop";

export interface CatalogCarGarage {
  /** The garage of this launch has been read (a guest's — from the device; an account's — synced). */
  loaded: boolean;
  carIds: readonly string[];
}

export function catalogCarDecision(carId: string, garage: CatalogCarGarage): CatalogCarDecision {
  if (garage.carIds.includes(carId)) return "apply";
  return garage.loaded ? "drop" : "wait";
}

let pending: string | null = null;
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of listeners) listener();
}

/** A push asks for this car; a newer request replaces one that waits. */
export function requestCatalogCar(carId: string): void {
  pending = carId;
  changed();
}

/** The car a request waits with; `null` — none. */
export function pendingCatalogCar(): string | null {
  return pending;
}

export function subscribeCatalogCarRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Decides the waiting request against the garage as it is now: applied or
 * dropped, it is gone; waiting, it stays. Returns the car to make the main
 * one, or `null`.
 */
export function takeCatalogCarRequest(garage: CatalogCarGarage): string | null {
  const carId = pending;
  if (carId === null) return null;
  const decision = catalogCarDecision(carId, garage);
  if (decision === "wait") return null;
  pending = null;
  changed();
  return decision === "apply" ? carId : null;
}
