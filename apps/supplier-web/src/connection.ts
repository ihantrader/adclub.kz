import { useSyncExternalStore } from "react";

/**
 * «Нет сети» (SCREENS 2.4, 6.0): the browser says it is offline, or the last
 * request to the API got no answer at all. Any answer from the server —
 * even an error — means the network is there again.
 */
let browserOnline = typeof navigator === "undefined" ? true : navigator.onLine;
let lastRequestFailed = false;
const listeners = new Set<() => void>();
let snapshot = browserOnline && !lastRequestFailed;

function publish(): void {
  const next = browserOnline && !lastRequestFailed;
  if (next === snapshot) return;
  snapshot = next;
  listeners.forEach((listener) => listener());
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    browserOnline = true;
    // A request will tell soon; until then, trust the browser.
    lastRequestFailed = false;
    publish();
  });
  window.addEventListener("offline", () => {
    browserOnline = false;
    publish();
  });
}

/** How often the server is asked whether it answers again, while it doesn't. */
const PROBE_INTERVAL_MS = 10_000;
let probeUrl: string | null = null;
let probeTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * The address to ask (`/health`, cheap and never refused): when the
 * browser keeps saying it is online but the server didn't answer, nothing
 * else would ever clear «Нет сети» — the actions it disables wouldn't send
 * a request. So the probe does, every few seconds, until there is an answer.
 */
export function setReachabilityProbe(url: string): void {
  probeUrl = url;
}

function scheduleProbe(): void {
  if (probeTimer !== undefined || probeUrl === null || typeof window === "undefined") return;
  probeTimer = setTimeout(() => {
    probeTimer = undefined;
    if (!lastRequestFailed || probeUrl === null) return;
    fetch(probeUrl, { cache: "no-store" }).then(
      () => reportRequestOutcome(true),
      () => scheduleProbe(),
    );
  }, PROBE_INTERVAL_MS);
}

export function reportRequestOutcome(reachedServer: boolean): void {
  lastRequestFailed = !reachedServer;
  publish();
  if (!reachedServer) scheduleProbe();
}

export function isOnline(): boolean {
  return snapshot;
}

export function subscribeOnline(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, isOnline);
}
