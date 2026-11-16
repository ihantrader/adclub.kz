import type { SupplierStats, SupplierStatsPeriod } from "@adclub/contracts";
import {
  EmptyState,
  Icon,
  LoadingContent,
  ScreenError,
  Segments,
  SkeletonList,
  useLoadingGate,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { apiClient } from "../api";
import type { Lang } from "@adclub/i18n";
import { useLanguage, type Translate } from "../i18n";
import { goBackTo } from "../router";
import { PageHeader } from "../screens/PageHeader";
import {
  dayText,
  noOrders,
  numberText,
  percentText,
  periodOf,
  ratingText,
  STATS_PERIODS,
  statsAddress,
} from "./stats-rules";

/**
 * S-STAT-01 «Статистика» (TASK-071; SCREENS 6.6; PRODUCT 12.6, 13): the
 * company's orders of the last 7 / 30 / 90 days by outcome, the views of its
 * offers, the share of answers and of terms kept, and the rating shown now.
 * The numbers are the server's (`GET /supplier/stats`) — the very count the
 * administrator sees on the company's card; the page computes nothing. Who
 * looked or ordered is never there.
 */
export function Stats() {
  const { t, lang } = useLanguage();
  const online = useOnline();
  const gate = useLoadingGate();
  const { begin, settle } = gate;
  const [period, setPeriod] = useState<SupplierStatsPeriod>(() => periodOf(window.location.search));
  const [stats, setStats] = useState<SupplierStats | null>(null);
  const [failure, setFailure] = useState<unknown>(null);

  const load = useCallback(async () => {
    const ticket = begin();
    try {
      const { stats: next } = await apiClient.getSupplierStats({ query: { period } });
      settle(ticket, () => {
        setStats(next);
        setFailure(null);
      });
    } catch (error) {
      settle(ticket, () => setFailure(error));
    }
  }, [begin, settle, period]);

  useEffect(() => {
    void load();
  }, [load]);

  // The network back: what failed is asked again.
  useEffect(() => {
    if (online && failure !== null) void load();
    // Only the moment the network comes back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online]);

  function choose(next: SupplierStatsPeriod) {
    setPeriod(next);
    window.history.replaceState(window.history.state, "", statsAddress(next));
  }

  const shown = stats;

  return (
    <>
      <PageHeader title={t("stats.title")} back={() => goBackTo("more")} deskRoot />
      <div className="stats-controls">
        <Segments<SupplierStatsPeriod>
          label={t("stats.period")}
          value={period}
          onChange={choose}
          options={STATS_PERIODS.map((value) => ({
            value,
            label: t(`stats.period.${value}`),
          }))}
        />
        <p className="ac-text-body-s ac-muted stats-note">
          <Icon name="info" size={16} />
          <span>{t("stats.testExcluded")}</span>
        </p>
      </div>
      {failure !== null && !shown ? (
        <ScreenError
          title={online ? t("common.errorTitle") : t("common.offline")}
          text={online ? t("common.errorText") : t("common.needNetwork")}
          retry={{ label: t("common.retry"), onRetry: () => load() }}
        />
      ) : (
        <LoadingContent
          ready={shown !== null}
          indicator={gate.indicator}
          skeleton={<SkeletonList rows={4} label={t("common.loading")} />}
          label={t("common.loading")}
          swapKey={shown ? `${shown.from}:${shown.to}` : undefined}
        >
          {shown && <Figures stats={shown} t={t} lang={lang} />}
        </LoadingContent>
      )}
      {failure !== null && shown && (
        <p className="ac-text-body-s ac-muted" role="status">
          {online ? t("common.errorTitle") : t("common.offline")}
        </p>
      )}
    </>
  );
}

function Figures({ stats: data, t, lang }: { stats: SupplierStats; t: Translate; lang: Lang }) {
  const responsePercent = percentText(data.shares.responsePercent);
  const onTimePercent = percentText(data.shares.onTimePercent);
  return (
    <div className="stack-m">
      <p className="ac-text-body-s ac-muted">
        {t("stats.range", { from: dayText(data.from, lang), to: dayText(data.to, lang) })}
      </p>
      {noOrders(data) ? (
        <EmptyState compact icon="receipt" title={t("stats.empty")} text={t("stats.emptyNote")} />
      ) : (
        <section className="card" aria-labelledby="stats-orders">
          <h2 id="stats-orders" className="ac-text-heading stats-card__title">
            {t("stats.orders")} · {numberText(data.orders.total, lang)}
          </h2>
          <dl className="stats-rows">
            <Row label={t("stats.completed")} value={numberText(data.orders.completed, lang)}>
              {data.orders.completedServices > 0 &&
                t("stats.completedServices", {
                  n: numberText(data.orders.completedServices, lang),
                })}
            </Row>
            <Row
              label={t("stats.cancelledByUser")}
              value={numberText(data.orders.cancelledByUser, lang)}
            />
            <Row
              label={t("stats.declined")}
              value={numberText(data.orders.declinedBySupplier, lang)}
            />
            <Row
              label={t("stats.expired")}
              value={numberText(data.orders.expiredNoResponse, lang)}
            />
          </dl>
        </section>
      )}
      <div className="stats-grid">
        <Figure
          label={t("stats.response")}
          value={responsePercent ?? t("stats.few")}
          muted={responsePercent === null}
          note={
            responsePercent === null
              ? t("stats.fewNote", { n: data.shares.minOrders })
              : t("stats.responseNote", {
                  answered: data.shares.answered,
                  required: data.shares.answerRequired,
                })
          }
        />
        <Figure
          label={t("stats.onTime")}
          value={onTimePercent ?? t("stats.few")}
          muted={onTimePercent === null}
          note={
            onTimePercent === null
              ? t("stats.fewNote", { n: data.shares.minOrders })
              : t("stats.onTimeNote", { kept: data.shares.kept, judged: data.shares.judged })
          }
        />
        <Figure
          label={t("stats.views")}
          value={numberText(data.views.total, lang)}
          note={t("stats.viewsClub", { n: numberText(data.views.club, lang) })}
        />
        <Figure
          label={t("stats.rating")}
          value={
            data.rating.score === null ? (
              t("stats.ratingNew")
            ) : (
              <span className="stats-rating">
                <Icon name="star" size={20} />
                {ratingText(data.rating.score, lang)}
              </span>
            )
          }
          muted={data.rating.score === null}
          note={
            data.rating.score === null
              ? t("stats.ratingNewNote", {
                  n: data.rating.minReviews,
                  days: data.rating.windowDays,
                })
              : `${t("stats.reviews", { n: data.rating.reviewsCount })}. ${t("stats.ratingNote", {
                  days: data.rating.windowDays,
                })}`
          }
        />
      </div>
    </div>
  );
}

function Row({ label, value, children }: { label: string; value: string; children?: ReactNode }) {
  return (
    <div className="stats-row">
      <dt>
        <span>{label}</span>
        {children && <span className="ac-text-body-s ac-muted">{children}</span>}
      </dt>
      <dd className="stats-row__value">{value}</dd>
    </div>
  );
}

function Figure({
  label,
  value,
  note,
  muted,
}: {
  label: string;
  value: ReactNode;
  note: string;
  muted?: boolean;
}) {
  return (
    <section className="card stats-figure">
      <span className="ac-text-body-s ac-muted">{label}</span>
      <span
        className={muted ? "stats-figure__value stats-figure__value--muted" : "stats-figure__value"}
      >
        {value}
      </span>
      <span className="ac-text-body-s ac-muted">{note}</span>
    </section>
  );
}
