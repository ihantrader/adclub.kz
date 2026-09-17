import {
  createThemeModeStore,
  resolveThemeName,
  themes,
  type Theme,
  type ThemeMode,
  type ThemeModeStorage,
  type ThemeName,
} from "@adclub/ui-core";
import {
  createContext,
  useContext,
  useInsertionEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

/**
 * `localStorage` under an app-specific key; any access error (private mode,
 * disabled storage) reads as "nothing stored" and writes are dropped.
 */
export function browserThemeStorage(key: string): ThemeModeStorage {
  return {
    read() {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    write(value) {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // Storage unavailable: the choice lasts until the page is closed.
      }
    },
  };
}

const DARK_QUERY = "(prefers-color-scheme: dark)";

function subscribeSystemScheme(listener: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => undefined;
  const query = window.matchMedia(DARK_QUERY);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}

function systemScheme(): ThemeName | null {
  if (typeof window === "undefined" || !window.matchMedia) return null;
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

export interface ThemeContextValue {
  /** The chosen mode: dark, light or system. */
  mode: ThemeMode;
  /** Changes the mode immediately and remembers it in this browser. */
  setMode: (mode: ThemeMode) => void;
  /** The theme actually rendered. */
  theme: Theme;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export interface ThemeProviderProps {
  /** `localStorage` key: each web client keeps its own choice. */
  storageKey: string;
  /** Mode before the user picks one (cabinet and admin: light). */
  defaultMode: ThemeMode;
  /** Test seam; defaults to `localStorage`. */
  storage?: ThemeModeStorage;
  children: ReactNode;
}

/**
 * Applies the theme to `<html data-theme>` (the CSS custom properties of
 * `theme.css` switch with it) and follows the OS scheme in "system" mode.
 */
export function ThemeProvider({ storageKey, defaultMode, storage, children }: ThemeProviderProps) {
  const [store] = useState(() =>
    createThemeModeStore(storage ?? browserThemeStorage(storageKey), defaultMode),
  );
  const mode = useSyncExternalStore(store.subscribe, store.getMode, store.getMode);
  const system = useSyncExternalStore(subscribeSystemScheme, systemScheme, () => null);
  const fallback = defaultMode === "dark" ? "dark" : "light";
  const name = resolveThemeName(mode, system, fallback);

  useInsertionEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = name;
    root.style.colorScheme = name;
  }, [name]);

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, setMode: store.setMode, theme: themes[name] }),
    [mode, name, store],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside <ThemeProvider>");
  return value;
}
