import { useSyncExternalStore } from "react";

/**
 * The cabinet's pages and their addresses (TASK-031 requirement 1): plain
 * paths that survive a reload, pushed onto the browser history so «назад»
 * works as expected. `/` opens the orders.
 */
export const routePaths = {
  orders: "/orders",
  offers: "/offers",
  scan: "/scan",
  more: "/more",
  settings: "/settings",
  team: "/team",
  company: "/company",
  install: "/install",
} as const;

export type RouteKey = keyof typeof routePaths;

/** The pages reached from «Ещё» on a phone; they open with «назад» to it. */
export const morePages: readonly RouteKey[] = ["settings", "team", "company", "install"];

export const DEFAULT_ROUTE: RouteKey = "orders";

/** The page of an address; `null` — not a page of the cabinet. */
export function routeOf(pathname: string): RouteKey | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return DEFAULT_ROUTE;
  for (const [key, value] of Object.entries(routePaths)) {
    if (value === path) return key as RouteKey;
  }
  return null;
}

/** The bottom tab a page belongs to on a phone. */
export function tabOf(route: RouteKey): "orders" | "offers" | "scan" | "more" {
  return morePages.includes(route) || route === "more"
    ? "more"
    : (route as "orders" | "offers" | "scan");
}

const listeners = new Set<() => void>();

function current(): RouteKey | null {
  return routeOf(window.location.pathname);
}

let snapshot: RouteKey | null = typeof window === "undefined" ? DEFAULT_ROUTE : current();

/** The page an in-app push came from (`null` after a reload or a history step). */
let cameFrom: RouteKey | null = null;

function publish(): void {
  snapshot = current();
  listeners.forEach((listener) => listener());
}

if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    cameFrom = null;
    publish();
  });
}

export function navigate(route: RouteKey, options: { replace?: boolean } = {}): void {
  const path = routePaths[route];
  if (window.location.pathname === path) return;
  if (options.replace) {
    window.history.replaceState(null, "", path);
  } else {
    cameFrom = current();
    window.history.pushState(null, "", path);
  }
  publish();
  window.scrollTo(0, 0);
}

/**
 * The arrow «назад» of a page: a step back in the history when the page was
 * opened from `parent`, otherwise (opened by its address) to `parent`
 * itself — never back to whatever site was open before the cabinet.
 */
export function goBackTo(parent: RouteKey): void {
  if (cameFrom === parent) window.history.back();
  else navigate(parent, { replace: true });
}

/** The page shown now; an unknown address is replaced by the orders. */
export function useRoute(): RouteKey {
  const route = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
  );
  if (route === null) {
    queueMicrotask(() => navigate(DEFAULT_ROUTE, { replace: true }));
    return DEFAULT_ROUTE;
  }
  return route;
}
