import { Banner, Button } from "@adclub/ui";
import { useT } from "../i18n";
import { AuthLayout } from "./AuthLayout";

/**
 * «Нужно обновить» (SCREENS 2.6): the server said this build is below
 * `client_min_version_supplier_web`. A web page updates by reloading — the
 * service worker takes pages from the network first, so the reload is the
 * new version.
 */
export function UpdateRequired({ message }: { message: string }) {
  const t = useT();
  return (
    <AuthLayout>
      <section role="alert" className="auth-stack">
        <h1 className="ac-text-title">{t("update.title")}</h1>
        {message && <Banner tone="warning">{message}</Banner>}
        <Button size="l" block icon="refresh" onClick={() => window.location.reload()}>
          {t("update.reload")}
        </Button>
      </section>
    </AuthLayout>
  );
}
