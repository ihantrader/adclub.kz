import { useSyncExternalStore } from "react";

/**
 * The cabinet's pages and their addresses (TASK-031 requirement 1): plain
 * paths that survive a reload, pushed onto the browser history so «назад»
 * works as expected. `/` opens the orders. An offer has its own address,
 * `/offers/<id>` (TASK-032).
 */
export const routePaths = {
  orders: "/orders",
  offers: "/offers",
  offerSearch: "/offers/search",
  offerNew: "/offers/new",
  scan: "/scan",
  more: "/more",
  settings: "/settings",
  team: "/team",
  company: "/company",
  install: "/install",
} as const;

/** A page with a fixed address. */
export type StaticRoute = keyof typeof routePaths;

/** Every page; `offer` — one offer, `/offers/<id>`. */
export type RouteKey = StaticRoute | "offer";

/** The pages reached from «Ещё» on a phone; they open with «назад» to it. */
export const morePages: readonly RouteKey[] = ["settings", "team", "company", "install"];

/** The pages under «Предложения»: their own arrow «назад» in the page (S-OFF-02, S-OFF-03). */
export const offerPages: readonly RouteKey[] = ["offerSearch", "offerNew", "offer"];

export const DEFAULT_ROUTE: StaticRoute = "orders";

const OFFER_PATH = /^\/offers\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function offerPath(offerId: string): string {
  return `/offers/${offerId}`;
}

/** The page of an address and its id (an offer's); `route: null` — not a page of the cabinet. */
export function locationOf(pathname: string): { route: RouteKey | null; id: string | null } {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return { route: DEFAULT_ROUTE, id: null };
  for (const [key, value] of Object.entries(routePaths)) {
    if (value === path) return { route: key as StaticRoute, id: null };
  }
  const offer = OFFER_PATH.exec(path);
  if (offer) return { route: "offer", id: offer[1]!.toLowerCase() };
  return { route: null, id: null };
}

/** The page of an address; `null` — not a page of the cabinet. */
export function routeOf(pathname: string): RouteKey | null {
  return locationOf(pathname).route;
}

/** The bottom tab (and the side menu item) a page belongs to. */
export function tabOf(route: RouteKey): "orders" | "offers" | "scan" | "more" {
  if (morePages.includes(route) || route === "more") return "more";
  if (offerPages.includes(route)) return "offers";
  return route as "orders" | "offers" | "scan";
}

/** The side menu item of a page (the sections of «Ещё» are items of their own there). */
export function menuOf(route: RouteKey): StaticRoute {
  if (route === "more") return "settings";
  if (route === "offer" || offerPages.includes(route)) return "offers";
  return route;
}

interface Location {
  route: RouteKey | null;
  id: string | null;
  /** `history.state` of the entry: what a page was opened with (it survives a reload). */
  state: unknown;
}

const listeners = new Set<() => void>();

function current(): Location {
  return { ...locationOf(window.location.pathname), state: window.history.state as unknown };
}

let snapshot: Location =
  typeof window === "undefined" ? { route: DEFAULT_ROUTE, id: null, state: null } : current();

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

/** Goes to an address of the cabinet; `state` goes with the history entry. */
export function navigateTo(path: string, options: { replace?: boolean; state?: unknown } = {}) {
  const state = options.state ?? null;
  if (window.location.pathname === path && state === null) return;
  if (options.replace) {
    window.history.replaceState(state, "", path);
  } else {
    cameFrom = snapshot.route;
    window.history.pushState(state, "", path);
  }
  publish();
  window.scrollTo(0, 0);
}

export function navigate(
  route: StaticRoute,
  options: { replace?: boolean; state?: unknown } = {},
): void {
  navigateTo(routePaths[route], options);
}

/**
 * The arrow «назад» of a page: a step back in the history when the page was
 * opened from `parent`, otherwise (opened by its address) to `parent`
 * itself — never back to whatever site was open before the cabinet.
 */
export function goBackTo(parent: StaticRoute): void {
  if (cameFrom === parent) window.history.back();
  else navigate(parent, { replace: true });
}

/**
 * «Назад» of a page opened from another page of the cabinet — wherever
 * from (an offer from its list or from the search); opened by its address —
 * to `fallback`.
 */
export function goBack(fallback: StaticRoute): void {
  if (cameFrom !== null) window.history.back();
  else navigate(fallback, { replace: true });
}

function useLocation(): Location {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
  );
}

/** The page shown now; an unknown address is replaced by the orders. */
export function useRoute(): RouteKey {
  const { route } = useLocation();
  if (route === null) {
    queueMicrotask(() => navigate(DEFAULT_ROUTE, { replace: true }));
    return DEFAULT_ROUTE;
  }
  return route;
}

/** The id in the address (`/offers/<id>`), `null` on other pages. */
export function useRouteId(): string | null {
  return useLocation().id;
}

/** What the page was opened with (`navigateTo(…, { state })`); kept over a reload. */
export function useRouteState(): unknown {
  return useLocation().state;
}

/** Replaces what the current entry carries (the page's own memory of a reload). */
export function replaceRouteState(state: unknown): void {
  window.history.replaceState(state, "", window.location.pathname);
  publish();
}
