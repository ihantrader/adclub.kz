import { useSyncExternalStore } from "react";

/**
 * How many unused backup codes the latest sign-in said were left (A-AUTH:
 * «коды кончились — подсказка „Новые резервные коды“»). Only the count, in
 * this page's memory; the codes themselves are never kept anywhere.
 */
let remaining: number | null = null;
const listeners = new Set<() => void>();

export function setBackupCodesRemaining(value: number | null): void {
  remaining = value;
  listeners.forEach((listener) => listener());
}

export function useBackupCodesRemaining(): number | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => remaining,
  );
}

/** Few enough to remind about: none left, or the last two. */
export const BACKUP_CODES_LOW = 2;
