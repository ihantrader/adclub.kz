import { ThemeProvider, ToastProvider } from "@adclub/ui";
import { defaultThemeMode } from "@adclub/ui-core";
import type { ReactNode } from "react";

/** Also read by the inline script in index.html — keep both in sync. */
export const THEME_STORAGE_KEY = "adclub.admin-web.theme";

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider storageKey={THEME_STORAGE_KEY} defaultMode={defaultThemeMode.adminWeb}>
      <ToastProvider>{children}</ToastProvider>
    </ThemeProvider>
  );
}
