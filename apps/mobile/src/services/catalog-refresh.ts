/**
 * Cards of items that are known to show something no longer true (TASK-030):
 * the checkout learned from the server that an offer of the card was
 * withdrawn (`ORDER_OFFER_UNAVAILABLE`), and the card under it must load its
 * offers again when it is back on screen — not in a minute, when its answer
 * would turn stale by itself (ARCHITECTURE 4.38 I402).
 */
const stale = new Set<string>();

export const catalogRefresh = {
  /** The card of this item shows offers that are gone. */
  mark(itemId: string): void {
    stale.add(itemId);
  },
  /** Whether the card must load again — answered once. */
  take(itemId: string): boolean {
    return stale.delete(itemId);
  },
};
