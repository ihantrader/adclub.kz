import { useSyncExternalStore } from "react";

const WIDE = "(min-width: 1024px)";

function query(): MediaQueryList | null {
  return typeof window === "undefined" || !window.matchMedia ? null : window.matchMedia(WIDE);
}

/** From 1024 px — the side menu and tables (DESIGN 7.5); below — cards. */
export function useWide(): boolean {
  return useSyncExternalStore(
    (listener) => {
      const list = query();
      list?.addEventListener("change", listener);
      return () => list?.removeEventListener("change", listener);
    },
    () => query()?.matches ?? false,
  );
}
