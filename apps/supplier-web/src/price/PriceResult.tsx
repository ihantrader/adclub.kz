import type { PriceImport, PriceReviewRow, PriceRowNotAppliedReason } from "@adclub/contracts";
import { Banner, Button, Icon } from "@adclub/ui";
import { useState } from "react";
import { apiClient } from "../api";
import { useLanguage } from "../i18n";
import { navigate } from "../router";
import { formatNumber } from "./price-rules";
import {
  fileText,
  notAppliedGroups,
  notAppliedText,
  resultLines,
  resultText,
} from "./review-rules";

/**
 * S-PRICE-04 «Итог» (TASK-048): «Готово: обновлено N, снято M, на
 * добавление отправлено K — результат в разделе „Модерация“» by the
 * server's `result`; created, back on sale, withdrawn by «нет в наличии»;
 * «Не применено» by reason in words, each with its rows; «К предложениям»;
 * «Цены в созданных заявках не меняются».
 */
export function PriceResult({ entry }: { entry: PriceImport }) {
  const { t } = useLanguage();
  const result = entry.result;
  if (!result) return null;
  const groups = notAppliedGroups(result);
  return (
    <div className="stack-m price-result">
      <section className="card">
        <p className="ac-text-title-s price-result__done">
          <Icon name="circleCheck" size={24} />
          <span>{resultText(result, t)}</span>
        </p>
        {resultLines(result, t).length > 0 && (
          <ul className="price-result__lines">
            {resultLines(result, t).map((line) => (
              <li key={line} className="ac-text-body">
                {line}
              </li>
            ))}
          </ul>
        )}
        <p className="ac-text-body-s ac-muted">{t("result.ordersNote")}</p>
        <div className="actions-row">
          <Button onClick={() => navigate("offers")}>{t("result.toOffers")}</Button>
          <Button variant="secondary" onClick={() => navigate("moderation")}>
            {t("result.toModeration")}
          </Button>
        </div>
      </section>
      {groups.length > 0 && (
        <section className="stack-s" aria-label={t("result.notApplied")}>
          <h2 className="ac-text-title-s">{t("result.notApplied")}</h2>
          <ul className="price-errors">
            {groups.map((group) => (
              <NotAppliedGroup
                key={group.reason}
                importId={entry.id}
                reason={group.reason}
                rows={group.rows}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** One reason of «Не применено» and, on demand, its rows of the file. */
function NotAppliedGroup({
  importId,
  reason,
  rows,
}: {
  importId: string;
  reason: PriceRowNotAppliedReason;
  rows: number;
}) {
  const { t } = useLanguage();
  const [shown, setShown] = useState<PriceReviewRow[] | null>(null);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);

  const toggle = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (shown) return;
    try {
      // A row not applied was «уверенно» or decided in «Нужно проверить».
      const pages = await Promise.all(
        (["confident", "review", "not_found"] as const).map((group) =>
          apiClient.listPriceReviewRows(
            { importId },
            { query: { group, notApplied: reason, limit: 200 } },
          ),
        ),
      );
      setShown(pages.flatMap((page) => page.rows).sort((a, b) => a.rowNo - b.rowNo));
    } catch {
      setFailed(true);
    }
  };

  return (
    <li className="price-result__reason">
      <div className="price-result__reason-head">
        <span>
          {notAppliedText(reason, t)} — {formatNumber(rows)}
        </span>
        <button type="button" className="text-link" aria-expanded={open} onClick={() => toggle()}>
          {t(open ? "result.hideRows" : "result.showRows")}
        </button>
      </div>
      {open && failed && <Banner tone="danger">{t("common.errorText")}</Banner>}
      {open && shown && (
        <ul className="price-result__rows">
          {shown.map((row) => (
            <li key={row.rowNo} className="ac-text-body-s">
              <span className="ac-muted">{t("price.parsed.row", { n: row.rowNo })}</span>{" "}
              <span className="price-wrap">{fileText(row)}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
