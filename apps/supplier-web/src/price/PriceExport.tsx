import { isApiError } from "@adclub/api-client";
import { Banner, Button, Segments } from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useState } from "react";
import { apiClient } from "../api";
import { API_URL } from "../config";
import { retryMinutes } from "../errors";
import { useT } from "../i18n";

type Include = "on_sale" | "all";

/**
 * «Скачать мой прайс» of S-PRICE-01 (TASK-048): the company's own offers on
 * goods as an `.xlsx` — on sale (by default) or with the withdrawn ones.
 * The server gives a short link and the browser downloads it as an ordinary
 * file; the file uploaded back is matched by its hidden first column.
 */
export function PriceExport() {
  const t = useT();
  const online = useOnline();
  const [include, setInclude] = useState<Include>("on_sale");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function download() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const link = await apiClient.createPriceExport({ include });
      if (link.offers === 0) setNote(t("price.export.empty"));
      // An attachment: the page stays where it is and the browser saves the file.
      window.location.assign(`${API_URL}${link.url}`);
    } catch (failure) {
      setError(
        isApiError(failure) && failure.code === "RATE_LIMITED"
          ? t("price.export.tooMany", { minutes: retryMinutes(failure) })
          : isApiError(failure) && failure.code === "NETWORK_ERROR"
            ? t("common.offline")
            : t("common.errorText"),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card price-export" aria-label={t("price.export.title")}>
      <div className="stack-s">
        <h2 className="ac-text-title-s">{t("price.export.title")}</h2>
        <p className="ac-text-body-s ac-muted">{t("price.export.hint")}</p>
      </div>
      <Segments<Include>
        label={t("price.export.which")}
        value={include}
        onChange={setInclude}
        options={[
          { value: "on_sale", label: t("price.export.onSale") },
          { value: "all", label: t("price.export.all") },
        ]}
      />
      <div>
        <Button
          variant="secondary"
          icon="download"
          loading={busy}
          disabled={!online || busy}
          onClick={() => download()}
        >
          {t("price.export.download")}
        </Button>
      </div>
      {note && <Banner icon="info">{note}</Banner>}
      {error && <Banner tone="danger">{error}</Banner>}
    </section>
  );
}
