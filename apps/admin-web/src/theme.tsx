import { browserThemeStorage, ThemeProvider, ToastProvider } from "@adclub/ui";
import type { ThemeModeStorage } from "@adclub/ui-core";
import type { ReactNode } from "react";

/**
 * The admin panel is light only (DESIGN 7.3; TASK-077): no switch, the
 * system's dark scheme is not followed, and a choice stored by an older
 * build is not read.
 */
const alwaysLight: ThemeModeStorage = {
  read: () => "light",
  write: () => undefined,
};

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider storageKey="" defaultMode="light" storage={alwaysLight}>
      <ToastProvider>{children}</ToastProvider>
    </ThemeProvider>
  );
}

/** The development showcase still shows the components in both themes. */
export function ShowcaseProviders({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider
      storageKey="adclub.admin-web.showcase-theme"
      defaultMode="light"
      storage={browserThemeStorage("adclub.admin-web.showcase-theme")}
    >
      <ToastProvider>{children}</ToastProvider>
    </ThemeProvider>
  );
}
