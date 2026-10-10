import { useSyncExternalStore } from "react";

/**
 * «Выбрать из списка» appears only after recognition did not work (D-064,
 * SCREENS M-START-05, M-GAR-02): a certificate that could not be read,
 * another document, no camera, recognition unavailable, no attempts left,
 * no network. Once that happened in this run of the app, the list is
 * offered next to the camera on every way of adding a car; a new start of
 * the app asks for the photo first again.
 */
let allowed = false;
const listeners = new Set<() => void>();

export const listFallback = {
  get: (): boolean => allowed,
  allow(): void {
    if (allowed) return;
    allowed = true;
    listeners.forEach((listener) => listener());
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function useListFallback(): boolean {
  return useSyncExternalStore(listFallback.subscribe, listFallback.get);
}
