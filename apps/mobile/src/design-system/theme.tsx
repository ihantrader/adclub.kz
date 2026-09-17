import {
  createThemeModeStore,
  defaultThemeMode,
  resolveThemeName,
  themes,
  type Theme,
  type ThemeMode,
  type ThemeModeStore,
} from "@adclub/ui-core";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SystemUI from "expo-system-ui";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { AccessibilityInfo, Appearance, useColorScheme } from "react-native";

const STORAGE_KEY = "adclub.mobile.theme";

/**
 * The app-wide mode store: dark by default (DESIGN.md 7.3), the choice kept in
 * AsyncStorage on the device. Screens change it through `useTheme().setMode`.
 */
export const themeModeStore: ThemeModeStore = createThemeModeStore(
  {
    read: () => AsyncStorage.getItem(STORAGE_KEY),
    write: (value) => AsyncStorage.setItem(STORAGE_KEY, value),
  },
  defaultThemeMode.mobile,
);

export interface ThemeContextValue {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  theme: Theme;
  /** System "reduce motion": no blinking, no shimmer, no slides. */
  reduceMotion: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function useReduceMotion(): boolean {
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (active) setReduceMotion(value);
    });
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);
  return reduceMotion;
}

/**
 * Resolves the theme and keeps native UI in step: an explicit dark/light
 * choice overrides the app's color scheme (alerts, keyboards, pickers
 * follow it); "system" hands it back to the OS, and `useColorScheme` then
 * updates while the app is open.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const mode = useSyncExternalStore(themeModeStore.subscribe, themeModeStore.getMode);
  const system = useColorScheme();
  const name = resolveThemeName(mode, system === "unspecified" ? null : system, "dark");
  const reduceMotion = useReduceMotion();

  useEffect(() => {
    Appearance.setColorScheme(mode === "system" ? "unspecified" : mode);
  }, [mode]);

  useEffect(() => {
    // Root view background: no white flash behind screens and the keyboard.
    void SystemUI.setBackgroundColorAsync(themes[name].colors.bg);
  }, [name]);

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, setMode: themeModeStore.setMode, theme: themes[name], reduceMotion }),
    [mode, name, reduceMotion],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside <ThemeProvider>");
  return value;
}
