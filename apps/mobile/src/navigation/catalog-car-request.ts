/**
 * «Open the catalog for this car» from outside a screen (TASK-069): a push of
 * a reminder (P-REM-01/02) names the car it is about, and the catalog's home
 * shows it in its header. The catalog tab takes the request and makes the
 * car the main one — the header's own way of choosing a car (M-CAT-01); a
 * request that waits for the tab is kept until it reads it.
 */

type Listener = (carId: string) => void;

let pending: string | null = null;
const listeners = new Set<Listener>();

export function requestCatalogCar(carId: string): void {
  if (listeners.size === 0) {
    pending = carId;
    return;
  }
  for (const listener of listeners) listener(carId);
}

/** The catalog tab listens; a request that came before it is handed over at once. */
export function onCatalogCarRequest(listener: Listener): () => void {
  listeners.add(listener);
  if (pending !== null) {
    const carId = pending;
    pending = null;
    listener(carId);
  }
  return () => {
    listeners.delete(listener);
  };
}
