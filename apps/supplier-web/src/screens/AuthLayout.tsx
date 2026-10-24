import { Logo } from "@adclub/ui";
import type { ReactNode } from "react";
import { useT } from "../i18n";
import { LanguageSwitch } from "./LanguageSwitch";

/**
 * The frame of the sign-in screens and of the screens shown before the
 * cabinet. From 600 px a `surface` card of 400 in the middle of the window,
 * the brand line under the mark, the language right under the card
 * (TASK-079); on a phone the same column without the card.
 */
export function AuthLayout({ children }: { children: ReactNode }) {
  const t = useT();
  return (
    <main className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <Logo height={40} />
          <p className="ac-text-caption ac-muted">{t("auth.brandLine")}</p>
        </div>
        {children}
      </div>
      <div className="auth-footer">
        <LanguageSwitch />
      </div>
    </main>
  );
}
