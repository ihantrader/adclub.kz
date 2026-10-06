import { Button, DelayedSkeleton, Logo, Spinner, useDelayedIndicator } from "@adclub/ui";
import { useT } from "../i18n";
import { AuthLayout } from "./AuthLayout";

/** The first moments of the page: the session is being found out (the cookie exchange). */
export function Starting() {
  const t = useT();
  // A quick start shows nothing but the background, then the cabinet fades
  // in; the logo and the spinner only when it takes longer (D-069).
  const indicator = useDelayedIndicator(true);
  return (
    <main className="splash" aria-busy="true">
      <DelayedSkeleton indicator={indicator}>
        <div className="splash__content">
          <Logo height={48} />
          <Spinner />
        </div>
      </DelayedSkeleton>
      <span className="ac-visually-hidden">{t("common.loading")}</span>
    </main>
  );
}

/**
 * Opened without a network and without anything known about the person
 * (SCREENS 2.4): the page says so instead of the browser's error. With a
 * network back it tries again by itself.
 */
export function Unreachable({ onRetry }: { onRetry: () => unknown }) {
  const t = useT();
  return (
    <AuthLayout>
      <div className="auth-stack" role="alert">
        <h1 className="ac-text-title">{t("auth.connectionFailed")}</h1>
        <p className="ac-text-body-s ac-muted">{t("common.errorText")}</p>
        <Button variant="secondary" icon="refresh" onClick={onRetry}>
          {t("common.retry")}
        </Button>
      </div>
    </AuthLayout>
  );
}
