import { useSyncExternalStore } from "react";

/**
 * The pages of the admin panel and their addresses (TASK-034 requirement 1):
 * plain paths that survive a reload, pushed onto the browser history so
 * «назад» works; filters of a list live in the query string of its address.
 * The sign-in has no address — it is shown over the requested page and
 * leaves the administrator on it (ARCHITECTURE 4.47 I491, 4.52).
 */
export const routePaths = {
  home: "/",
  signals: "/signals",
  settings: "/settings",
  clientPolicy: "/settings/client",
  cities: "/settings/cities",
  audit: "/audit",
  security: "/security",
  // Sections of the next tasks: an honest «появится» until then.
  catalog: "/catalog",
  vehicles: "/vehicles",
  suppliers: "/suppliers",
  orders: "/orders",
  users: "/users",
} as const;

export type StaticRoute = keyof typeof routePaths;

/** Every page; `settingHistory` — the history of one setting, `/settings/<key>/history`. */
export type RouteKey = StaticRoute | "settingHistory";

/** The sections that come with TASK-035 (catalog, cars) and TASK-036 (the rest). */
export const comingSections: Partial<Record<StaticRoute, "TASK-035" | "TASK-036">> = {
  catalog: "TASK-035",
  vehicles: "TASK-035",
  suppliers: "TASK-036",
  orders: "TASK-036",
  users: "TASK-036",
};

const HISTORY_PATH = /^\/settings\/([a-z][a-z0-9_]{0,63})\/history$/;

export function settingHistoryPath(key: string): string {
  return `/settings/${key}/history`;
}

export interface Location {
  route: RouteKey | null;
  /** The key of `settingHistory`. */
  id: string | null;
  /** The query string's values (filters of a list). */
  query: URLSearchParams;
}

/** The page of an address; `route: null` — not a page of the admin panel. */
export function locationOf(pathname: string, search = ""): Location {
  const path = pathname.replace(/\/+$/, "") || "/";
  const query = new URLSearchParams(search);
  for (const [key, value] of Object.entries(routePaths)) {
    if (value === path) return { route: key as StaticRoute, id: null, query };
  }
  const history = HISTORY_PATH.exec(path);
  if (history) return { route: "settingHistory", id: history[1]!, query };
  return { route: null, id: null, query };
}

/** The menu item a page belongs to. */
export function menuOf(route: RouteKey): StaticRoute {
  if (route === "settingHistory" || route === "clientPolicy" || route === "cities") {
    return "settings";
  }
  return route;
}

/** An address with the filters that are set (empty values left out). */
export function withQuery(path: string, values: Record<string, string | null | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value) query.set(key, value);
  }
  const text = query.toString();
  return text ? `${path}?${text}` : path;
}

const listeners = new Set<() => void>();

function read(): Location {
  return locationOf(window.location.pathname, window.location.search);
}

let snapshot: Location =
  typeof window === "undefined"
    ? { route: "home", id: null, query: new URLSearchParams() }
    : read();

/** Whether the current entry was pushed by the admin panel itself (not opened by its address). */
let cameFromApp = false;

function publish(): void {
  snapshot = read();
  listeners.forEach((listener) => listener());
}

if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    cameFromApp = false;
    publish();
  });
}

/** Goes to an address of the admin panel. */
export function navigateTo(path: string, options: { replace?: boolean } = {}): void {
  const current = window.location.pathname + window.location.search;
  if (current === path) return;
  if (options.replace) {
    window.history.replaceState(null, "", path);
  } else {
    cameFromApp = true;
    window.history.pushState(null, "", path);
    window.scrollTo(0, 0);
  }
  publish();
}

export function navigate(route: StaticRoute): void {
  navigateTo(routePaths[route]);
}

/** «Назад» of a page: a step back when it was opened from the admin panel, else to `fallback`. */
export function goBack(fallback: StaticRoute): void {
  if (cameFromApp) window.history.back();
  else navigateTo(routePaths[fallback], { replace: true });
}

export function useLocation(): Location {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
  );
}

/** The page shown now; an unknown address is replaced by the home page. */
export function useRoute(): RouteKey {
  const { route } = useLocation();
  if (route === null) {
    queueMicrotask(() => navigateTo(routePaths.home, { replace: true }));
    return "home";
  }
  return route;
}
