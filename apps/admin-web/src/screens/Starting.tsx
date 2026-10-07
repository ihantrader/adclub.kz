import { Banner, Button, DelayedSkeleton, Logo, Spinner, useDelayedIndicator } from "@adclub/ui";
import { AuthLayout } from "./AuthLayout";

/** The first moments of the page: the session is being found out (the cookie exchange). */
export function Starting() {
  // A quick start shows nothing but the background, then the admin panel
  // fades in; the logo and the spinner only when it takes longer (D-069).
  const indicator = useDelayedIndicator(true);
  return (
    <main className="splash" aria-busy="true">
      <DelayedSkeleton indicator={indicator}>
        <div className="splash__content">
          <Logo height={48} />
          <Spinner />
        </div>
      </DelayedSkeleton>
      <span className="ac-visually-hidden">Загрузка</span>
    </main>
  );
}

/** Opened without a network: the page says so instead of the browser's error, and tries again. */
export function Unreachable({ onRetry }: { onRetry: () => unknown }) {
  return (
    <AuthLayout>
      <div className="auth-stack" role="alert">
        <h1 className="ac-text-title">Нет связи с сервером</h1>
        <p className="ac-text-body-s ac-muted">
          Проверьте интернет. Админка попробует снова сама, когда связь вернётся.
        </p>
        <Button variant="secondary" icon="refresh" onClick={onRetry}>
          Повторить
        </Button>
      </div>
    </AuthLayout>
  );
}

/**
 * «Нужно обновить» (SCREENS 2.6): this build is below
 * `client_min_version_admin_web`. A web page updates by reloading.
 */
export function UpdateRequired({ message }: { message: string }) {
  return (
    <AuthLayout>
      <section role="alert" className="auth-stack">
        <h1 className="ac-text-title">Нужно обновить админку</h1>
        {message && <Banner tone="warning">{message}</Banner>}
        <Button size="l" block icon="refresh" onClick={() => window.location.reload()}>
          Обновить страницу
        </Button>
      </section>
    </AuthLayout>
  );
}

/**
 * The admin panel is for a computer (SCREENS 7.0): narrower than 1024 px it
 * says so instead of squeezing tables. Shown by CSS, over everything.
 */
export function NarrowNotice() {
  return (
    <div className="narrow-notice" role="note">
      <Logo height={36} />
      <h1 className="ac-text-title">Админка рассчитана на компьютер</h1>
      <p className="ac-text-body-s ac-muted">
        Откройте её на экране шириной от 1024 пикселей или разверните окно браузера.
      </p>
    </div>
  );
}
