import { useEffect, useRef, useSyncExternalStore } from "react";
import { apiClient } from "../api";
import { isOnline } from "@adclub/web-session";

/**
 * What keeps «Заявки» current while the cabinet is open (TASK-033): one
 * clock for every timer on the page, a poll that runs only while the page
 * is visible, and the number of new orders the tabs and the side menu
 * show on every page.
 */

// ------------------------------------------------------------------ clock

/** How often the timers look at the clock: a minute timer never lags more than this. */
const CLOCK_STEP_MS = 5_000;

let now = Date.now();
const clockListeners = new Set<() => void>();
let clockTimer: ReturnType<typeof setInterval> | undefined;

function tick(): void {
  now = Date.now();
  clockListeners.forEach((listener) => listener());
}

function onVisibility(): void {
  if (document.visibilityState === "visible") tick();
}

/**
 * The time every timer of the page reads: one interval for all of them
 * (dozens of new orders never mean dozens of timers), set to the real
 * time again the moment the page comes back on screen.
 */
export function useNow(): number {
  return useSyncExternalStore(
    (listener) => {
      clockListeners.add(listener);
      if (clockListeners.size === 1) {
        clockTimer = setInterval(tick, CLOCK_STEP_MS);
        document.addEventListener("visibilitychange", onVisibility);
      }
      return () => {
        clockListeners.delete(listener);
        if (clockListeners.size === 0) {
          clearInterval(clockTimer);
          document.removeEventListener("visibilitychange", onVisibility);
        }
      };
    },
    () => now,
  );
}

// ------------------------------------------------------------------- poll

/**
 * Calls `poll` every `intervalMs` while the page is visible and online,
 * and once more as soon as it comes back on screen. A hidden tab asks
 * nothing (TASK-033 requirement 1).
 */
export function useVisiblePoll(poll: () => void, intervalMs: number, enabled = true): void {
  const latest = useRef(poll);
  useEffect(() => {
    latest.current = poll;
  });

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      clearInterval(timer);
      timer = setInterval(() => {
        if (document.visibilityState === "visible" && isOnline()) latest.current();
      }, intervalMs);
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      latest.current();
      start();
    };
    start();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [intervalMs, enabled]);
}

// ------------------------------------------------------- new orders count

/** «Новые · N» of the company on screen; `null` — not known yet. */
let newOrders: { generation: number; count: number } | null = null;
const countListeners = new Set<() => void>();

function publishCount(next: { generation: number; count: number } | null): void {
  if (next?.count === newOrders?.count && next?.generation === newOrders?.generation) return;
  newOrders = next;
  countListeners.forEach((listener) => listener());
}

/** The list of «Заявки» tells the count with every answer it gets. */
export function reportNewOrders(generation: number, count: number): void {
  publishCount({ generation, count });
}

/** Asks for the count alone (the pages other than «Заявки»). */
export async function refreshNewOrders(generation: number): Promise<void> {
  try {
    const page = await apiClient.listSupplierOrders({ query: { tab: "new", limit: 1 } });
    publishCount({ generation, count: page.counts.new });
  } catch {
    // The banner of the network says it; the badge keeps what it knew.
  }
}

/** The count for the company of `generation` — never another company's. */
export function useNewOrders(generation: number | null): number | null {
  const value = useSyncExternalStore(
    (listener) => {
      countListeners.add(listener);
      return () => countListeners.delete(listener);
    },
    () => newOrders,
  );
  return value && value.generation === generation ? value.count : null;
}
