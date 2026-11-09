import { runEnvironment } from "../config/environment";
import { shouldCheckForUpdate, type UpdateCheckState } from "./ota-update-rule";

/**
 * OTA updates of the JavaScript (TASK-056 requirement 1, ARCHITECTURE 7.4,
 * 4.81): `expo-updates` with `runtimeVersion: appVersion`, so an update only
 * ever reaches the store version it was published for. The app looks for one
 * at start and on a return from the background, downloads it quietly and
 * runs it at the next start — never reloads in the middle of work, and the
 * splash does not wait for it (`checkAutomatically: NEVER`,
 * `fallbackToCacheTimeout: 0`). In Expo Go, the browser, a build without an
 * EAS project and offline it does nothing.
 */

type UpdatesModule = typeof import("expo-updates");

function load(): UpdatesModule | null {
  if (runEnvironment !== "own-build") return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("expo-updates") as UpdatesModule;
  } catch {
    return null;
  }
}

const updates = load();
const state: UpdateCheckState = { lastCheckAt: null, busy: false, downloaded: false };

/** Looks for an update and downloads it for the next start; every failure is silent. */
export async function checkForOtaUpdate(now = Date.now()): Promise<void> {
  if (!updates || !shouldCheckForUpdate(state, now, updates.isEnabled)) return;
  state.busy = true;
  state.lastCheckAt = now;
  try {
    const found = await updates.checkForUpdateAsync();
    if (found.isAvailable) {
      const fetched = await updates.fetchUpdateAsync();
      state.downloaded = fetched.isNew;
    }
  } catch {
    // No network, no project, the server of updates down: the code that runs stays.
  } finally {
    state.busy = false;
  }
}
