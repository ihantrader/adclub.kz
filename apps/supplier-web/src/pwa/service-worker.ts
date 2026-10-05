import { useSyncExternalStore } from "react";

/**
 * Registers the cabinet's service worker (`sw/service-worker.js`, filled in by
 * `sw/service-worker-plugin.ts`): the cabinet opens without a network as
 * its shell with «Нет сети», never as the browser's error page.
 *
 * Updates never get stuck: pages are taken from the network first, so the
 * next opening with a network is already the new version; the new worker
 * takes over at once, and a page that was open during the update offers
 * «Обновить» (TASK-031 requirement 4). Development builds don't register it
 * — Vite serves modules, not files a worker could keep.
 */
const UPDATE_CHECK_INTERVAL_MS = 60_000;

let updated = false;
const listeners = new Set<() => void>();

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  // The first worker taking control of this page is an installation, not an update.
  const hadController = navigator.serviceWorker.controller !== null;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || updated) return;
    void (async () => {
      // Pages come from the network first: a page opened after the deploy is
      // already the new version — only one that is not offers «Обновить».
      if (await belongsToNewVersion()) return;
      updated = true;
      listeners.forEach((listener) => listener());
    })();
  });
  navigator.serviceWorker
    .register("/sw.js")
    .then((registration) => {
      // An installed cabinet may stay open for days: look for a new version
      // whenever it comes back to the screen, not only on navigation.
      let checkedAt = Date.now();
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "visible") return;
        if (Date.now() - checkedAt < UPDATE_CHECK_INTERVAL_MS) return;
        checkedAt = Date.now();
        void registration.update().catch(() => undefined);
      });
    })
    .catch(() => {
      // No worker (an untrusted certificate, a private window): the cabinet
      // still works online.
    });
}

/**
 * Asks the worker that has just taken over whether this page's own script
 * is one of its files (the old version's cache may still exist at this
 * moment, so the caches themselves can't tell). No answer — assume not.
 */
function belongsToNewVersion(): Promise<boolean> {
  const script = document.querySelector<HTMLScriptElement>("script[type=module][src]");
  const controller = navigator.serviceWorker.controller;
  if (!script || !controller) return Promise.resolve(false);
  const path = new URL(script.src).pathname;
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(false), 2000);
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      clearTimeout(timer);
      resolve(event.data === true);
    };
    controller.postMessage({ type: "has-file", path }, [channel.port2]);
  });
}

/** A new version of the cabinet took over while this page was open. */
export function useAppUpdated(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => updated,
  );
}
