import { darkColors, lightColors, type ColorTokens } from "./tokens/colors";
import { floatShadow } from "./tokens/shape";

export type ThemeName = "dark" | "light";

export interface Theme {
  name: ThemeName;
  colors: ColorTokens;
  /** Shadow of floating elements; `null` — no shadow (dark theme). */
  floatShadow: (typeof floatShadow)[ThemeName];
}

export const themes: Record<ThemeName, Theme> = {
  dark: { name: "dark", colors: darkColors, floatShadow: floatShadow.dark },
  light: { name: "light", colors: lightColors, floatShadow: floatShadow.light },
};

/** "Тёмная" · "Светлая" · "Как в системе" (DESIGN.md 7.3). */
export type ThemeMode = ThemeName | "system";

export const themeModes: readonly ThemeMode[] = ["dark", "light", "system"];

/** Default mode per client (DESIGN.md 4, 7.3). */
export const defaultThemeMode = {
  mobile: "dark",
  supplierWeb: "light",
  adminWeb: "light",
} as const satisfies Record<string, ThemeMode>;

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === "dark" || value === "light" || value === "system";
}

/**
 * The theme to render. `system` follows the OS scheme; when the OS does not
 * report one (`null`), the client's default applies.
 */
export function resolveThemeName(
  mode: ThemeMode,
  systemScheme: ThemeName | null | undefined,
  fallback: ThemeName,
): ThemeName {
  if (mode !== "system") return mode;
  return systemScheme ?? fallback;
}

/** Storage the mode is kept in: `localStorage` on the web, AsyncStorage on the phone. */
export interface ThemeModeStorage {
  read(): string | null | Promise<string | null>;
  write(value: string): void | Promise<void>;
}

export interface ThemeModeStore {
  getMode(): ThemeMode;
  setMode(mode: ThemeMode): void;
  subscribe(listener: () => void): () => void;
  /** Resolves once the stored mode (if any) has been read. */
  ready: Promise<void>;
}

/**
 * Keeps the chosen mode in memory, persists changes and notifies subscribers.
 * Storage failures (private browsing, disabled storage) never break the UI:
 * the default mode stays in effect and changes still apply for the session.
 */
export function createThemeModeStore(
  storage: ThemeModeStorage,
  defaultMode: ThemeMode,
): ThemeModeStore {
  let mode = defaultMode;
  let changedBeforeRead = false;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());

  const apply = (stored: string | null) => {
    if (changedBeforeRead || !isThemeMode(stored) || stored === mode) return;
    mode = stored;
    notify();
  };

  let ready: Promise<void>;
  try {
    const stored = storage.read();
    if (stored instanceof Promise) {
      ready = stored.then(apply, () => undefined);
    } else {
      apply(stored);
      ready = Promise.resolve();
    }
  } catch {
    ready = Promise.resolve();
  }

  return {
    ready,
    getMode: () => mode,
    setMode(next) {
      changedBeforeRead = true;
      if (next === mode) return;
      mode = next;
      notify();
      try {
        const result = storage.write(next);
        if (result instanceof Promise) result.catch(() => undefined);
      } catch {
        // Unavailable storage: the choice lasts for this session only.
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
