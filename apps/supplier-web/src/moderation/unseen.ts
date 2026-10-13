import { useSyncExternalStore } from "react";
import { apiClient } from "../api";

/**
 * The counter of «Модерация» in the menu (S-MOD-01, TASK-048): the
 * administrator's decisions this employee hasn't seen yet — the server
 * keeps what each employee has seen. Kept for the company on screen only.
 */

let unseen: { generation: number; count: number } | null = null;
const listeners = new Set<() => void>();

export function publishModerationUnseen(generation: number, count: number): void {
  if (unseen?.generation === generation && unseen.count === count) return;
  unseen = { generation, count };
  listeners.forEach((listener) => listener());
}

/** Asks the server for the counter. */
export async function refreshModerationUnseen(generation: number): Promise<void> {
  try {
    const summary = await apiClient.getSupplierModerationSummary();
    publishModerationUnseen(generation, summary.unseen.total);
  } catch {
    // The banner of the network says it; the counter keeps what it knew.
  }
}

/** The counter for the company of `generation` — never another company's. */
export function useModerationUnseen(generation: number | null): number | null {
  const value = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => unseen,
  );
  return value && value.generation === generation ? value.count : null;
}
