import { useSyncExternalStore } from "react";
import { apiClient } from "../api";
import { factsOf, type BillingFacts } from "./billing-rules";

export { factsOf, type BillingFacts };

/**
 * What the frame of the cabinet needs to know about the company's card
 * (T-SUP-02, SCREENS 6.0): the switch D-041 is on and no card is linked, so
 * the offers are not on the showcase. Asked on every page (one small
 * request, like the counters of the menu) and told by «Подписка» with every
 * answer it gets. Kept for the company on screen only.
 */
let facts: { generation: number; value: BillingFacts } | null = null;
const listeners = new Set<() => void>();

export function publishBillingFacts(generation: number, value: BillingFacts): void {
  if (facts?.generation === generation && facts.value.cardMissing === value.cardMissing) return;
  facts = { generation, value };
  listeners.forEach((listener) => listener());
}

/** Asks the server. */
export async function refreshBillingFacts(generation: number): Promise<void> {
  try {
    publishBillingFacts(generation, factsOf(await apiClient.getSupplierSubscription()));
  } catch {
    // The banner of the network says it; the frame keeps what it knew.
  }
}

/** The facts for the company of `generation` — never another company's. */
export function useBillingFacts(generation: number | null): BillingFacts | null {
  const value = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => facts,
  );
  return value && value.generation === generation ? value.value : null;
}
