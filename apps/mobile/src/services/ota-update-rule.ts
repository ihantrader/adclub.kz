/**
 * When the app looks for an OTA update (TASK-056; `ota-updates.ts` applies
 * it): at start and on a return from the background, at most every 15
 * minutes, never twice at once, and not again once an update waits for the
 * next start.
 */
export const UPDATE_CHECK_INTERVAL_MS = 15 * 60_000;

export interface UpdateCheckState {
  /** When the last look started, `null` — never. */
  lastCheckAt: number | null;
  /** A look in flight. */
  busy: boolean;
  /** An update is downloaded and runs at the next start. */
  downloaded: boolean;
}

export function shouldCheckForUpdate(
  state: UpdateCheckState,
  now: number,
  enabled: boolean,
): boolean {
  if (!enabled || state.busy || state.downloaded) return false;
  return state.lastCheckAt === null || now - state.lastCheckAt >= UPDATE_CHECK_INTERVAL_MS;
}
