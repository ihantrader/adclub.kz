import { Logo } from "@adclub/ui";
import type { ReactNode } from "react";

/** The frame of the sign-in and of the screens before the admin panel. */
export function AuthLayout({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <main className="auth-page">
      <div className={wide ? "auth-card auth-card--wide" : "auth-card"}>
        <div className="auth-brand">
          <Logo height={36} />
          <span className="ac-text-caption ac-muted">Админка</span>
        </div>
        {children}
      </div>
    </main>
  );
}
