import { useSyncExternalStore } from "react";

/**
 * Putting the cabinet on the home screen (S-INST-01). Chrome and Edge on
 * Android (and on a computer) offer their own dialog: the page keeps the
 * `beforeinstallprompt` event and the «Установить» button shows it. Safari
 * on iPhone has no such event — only «Поделиться → На экран „Домой“», so
 * the page shows those steps. Other browsers get the words of their menu.
 */
export interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export type InstallWay = "installed" | "prompt" | "ios" | "menu";

export interface InstallEnvironment {
  userAgent: string;
  maxTouchPoints: number;
  standalone: boolean;
  hasPrompt: boolean;
  installedNow: boolean;
}

/** iPhone, iPod, iPad — including an iPad that calls itself a Mac. */
export function isIos(userAgent: string, maxTouchPoints: number): boolean {
  return /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
}

/** How this browser installs the cabinet, if it isn't installed already. */
export function installWay(environment: InstallEnvironment): InstallWay {
  if (environment.standalone || environment.installedNow) return "installed";
  if (environment.hasPrompt) return "prompt";
  if (isIos(environment.userAgent, environment.maxTouchPoints)) return "ios";
  return "menu";
}

let deferred: InstallPromptEvent | null = null;
let installedNow = false;
const listeners = new Set<() => void>();
let snapshot: InstallWay = "menu";

function standalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function publish(): void {
  snapshot = installWay({
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    standalone: standalone(),
    hasPrompt: deferred !== null,
    installedNow,
  });
  listeners.forEach((listener) => listener());
}

/** Called once before the app renders: the browser fires the event early. */
export function listenForInstall(): void {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferred = event as InstallPromptEvent;
    publish();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    installedNow = true;
    publish();
  });
  window.matchMedia?.("(display-mode: standalone)").addEventListener?.("change", publish);
  publish();
}

/** Shows the browser's own install dialog; `false` — it was dismissed or isn't available. */
export async function promptInstall(): Promise<boolean> {
  const event = deferred;
  if (!event) return false;
  await event.prompt();
  const { outcome } = await event.userChoice;
  // The event can be used once.
  deferred = null;
  if (outcome === "accepted") installedNow = true;
  publish();
  return outcome === "accepted";
}

/**
 * S-INST-01 is being offered right after a sign-in (it then has «Не сейчас»
 * and leads on to the orders); from «Ещё» it is just a page.
 */
let offeredNow = false;

export function offerInstallNow(offered: boolean): void {
  if (offeredNow === offered) return;
  offeredNow = offered;
  listeners.forEach((listener) => listener());
}

export function useInstallOfferedNow(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => offeredNow,
  );
}

export function useInstallWay(): InstallWay {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
  );
}
