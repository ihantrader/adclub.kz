import { apiRoutes, CLIENT_HEADER, formatClientHeader } from "@adclub/contracts";
import { apiUrl, clientInfo } from "../config/environment";
import { finishPendingLogout } from "../state/pending-logout";
import { pendingLogoutStore } from "../state/stores";
import { exchangeRefreshToken } from "./session-fetch";

/**
 * Finishes a sign-out made without a network (TASK-056, I866;
 * `state/pending-logout.ts`): at start, on a return from the background and
 * when the network comes back. It never goes through the app's session — the
 * device is a guest by now, maybe already signed in as someone else.
 */
let running: Promise<void> | null = null;

async function logoutWith(accessToken: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    return await globalThis.fetch(`${apiUrl}${apiRoutes.logout.path}`, {
      method: apiRoutes.logout.method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        [CLIENT_HEADER]: formatClientHeader(clientInfo),
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export function finishPendingLogoutSoon(): Promise<void> {
  running ??= (async () => {
    await pendingLogoutStore.ready;
    for (const pending of pendingLogoutStore.get()) {
      const result = await finishPendingLogout(pending, {
        logout: logoutWith,
        exchange: exchangeRefreshToken,
      });
      // Others may have been left meanwhile: only this one leaves the list.
      if (result === "done") {
        pendingLogoutStore.set(
          pendingLogoutStore.get().filter((entry) => entry.sessionId !== pending.sessionId),
        );
      }
    }
  })()
    .catch(() => undefined)
    .finally(() => {
      running = null;
    });
  return running;
}
