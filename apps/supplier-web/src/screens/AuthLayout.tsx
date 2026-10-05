import { Logo } from "@adclub/ui";
import type { ReactNode } from "react";
import { LanguageSwitch } from "./LanguageSwitch";

/** The frame of the sign-in screens and of the screens shown before the cabinet. */
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="auth-page">
      <div className="auth-card">
        <Logo height={40} />
        {children}
      </div>
      <div className="auth-footer">
        <LanguageSwitch />
      </div>
    </main>
  );
}
