import { isApiError } from "@adclub/api-client";
import type {
  SupplierCardBinding,
  SupplierCharge,
  SupplierSubscriptionResponse,
} from "@adclub/contracts";
import { formatDayTime } from "@adclub/i18n";
import {
  ActionBar,
  Badge,
  Banner,
  Button,
  EmptyState,
  LoadingContent,
  ScreenError,
  SkeletonList,
  useLoadingGate,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiClient } from "../api";
import { refreshCompany } from "../cabinet/cabinet-store";
import { API_URL } from "../config";
import { useLanguage } from "../i18n";
import { useWide } from "../offers/use-wide";
import { useVisiblePoll } from "../orders/live";
import { goBackTo, replaceRouteState, routePaths } from "../router";
import { PageHeader } from "../screens/PageHeader";
import { factsOf, publishBillingFacts } from "./billing-facts";
import {
  billingActions,
  billingErrorText,
  billingKind,
  bindingFinished,
  bindingNotice,
  brandKey,
  chargeKindKey,
  chargeOutcomeText,
  chargeTone,
  dayText,
  declineKey,
  maskText,
  mergeCharges,
  priceText,
  redirectTarget,
  replaceHead,
  stateBadge,
  stateTexts,
  termText,
  type BindingNotice,
} from "./billing-rules";

/** How often the page asks again while something is on its way (a binding, a charge). */
const POLL_MS = 1500;
const PAGE = 20;
/** A subscription is made within seconds of the first charge; past this the page stops waiting. */
const ACTIVATION_WAIT_MS = 40_000;
/** A paid subscription becomes active when the worker applies the payment: a few seconds. */
const SETTLE_WAIT_MS = 30_000;

type Pauses = { admin: unknown; billing: unknown };

interface Notice {
  tone: "neutral" | "warning" | "danger";
  icon?: "circleCheck" | "clock" | "alertTriangle" | "info";
  text: string;
}

/** The binding the page was opened for: the provider's page sends the browser back with `?binding=`. */
function remembered(state: unknown): string | null {
  return typeof state === "object" &&
    state !== null &&
    typeof (state as { binding?: unknown }).binding === "string"
    ? (state as { binding: string }).binding
    : null;
}

/**
 * S-BILL-01 «Подписка» (TASK-042; PRODUCT 14.1, 14.3; SCREENS 6.8): the five
 * states of a supplier's subscription — no card, active, a refused charge,
 * a pause, a change of the tariff — its card, and the history of charges.
 *
 * **The card never passes through the cabinet.** «Привязать карту» /
 * «Сменить карту» sends the browser to the payment provider's own page and
 * the provider sends it back to `/billing?binding=<id>`; the page then asks
 * how the trip ended (`GET /supplier/billing/card-bindings/{id}`) every
 * second and a half and says it in words: linked, refused by the bank (the
 * reason), the provider unreachable, or left unfinished (nothing broken: the
 * state is just «Карта не привязана»). The subscription itself is made by the
 * server's worker after the first charge — the page waits for it a few
 * seconds. «Оплатить сейчас» is one request, safe to press twice (the server
 * returns the charge already under way), and the result comes by the same
 * polling.
 */
export function Billing({
  generation,
  timeZone,
  pauses,
}: {
  generation: number;
  timeZone: string;
  /** The pauses the cabinet's company card knew when it loaded. */
  pauses: Pauses;
}) {
  const { t, lang } = useLanguage();
  const online = useOnline();
  const wide = useWide();
  const gate = useLoadingGate();
  const { begin, settle } = gate;

  const [data, setData] = useState<SupplierSubscriptionResponse | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [charges, setCharges] = useState<SupplierCharge[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const [bindingId, setBindingId] = useState<string | null>(null);
  const [binding, setBinding] = useState<SupplierCardBinding | null>(null);
  const [activatingSince, setActivatingSince] = useState<number | null>(null);
  const [starting, setStarting] = useState(false);

  const [paying, setPaying] = useState<{ chargeId: string | null } | null>(null);
  const [settling, setSettling] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const loaded = useRef(0);

  // The trip the provider's page sent the browser back from (kept over a reload).
  useEffect(() => {
    const fromQuery = new URLSearchParams(window.location.search).get("binding");
    if (fromQuery) replaceRouteState({ binding: fromQuery });
    // The address was just rewritten: what the entry now carries is the place to read it back
    // (an effect that runs twice must not forget what its first run found).
    setBindingId(fromQuery ?? remembered(window.history.state));
  }, []);

  const load = useCallback(async () => {
    const ticket = begin();
    try {
      const [next, page] = await Promise.all([
        apiClient.getSupplierSubscription(),
        apiClient.listSupplierCharges({ query: { limit: PAGE } }),
      ]);
      settle(ticket, () => {
        setData(next);
        setCharges((current) => replaceHead(current ?? [], page.charges, PAGE));
        // Pages loaded below the first keep their own boundary.
        setNextCursor((current) => (loaded.current > PAGE ? current : page.nextCursor));
        loaded.current = Math.max(loaded.current, page.charges.length);
        setFailure(null);
      });
      publishBillingFacts(generation, factsOf(next));
    } catch (error) {
      settle(ticket, () => setFailure(error));
    }
  }, [begin, settle, generation]);

  useEffect(() => {
    void load();
  }, [load]);

  // The company's pauses are the cabinet's frame: a payment lifts one, the frame learns it.
  useEffect(() => {
    if (!data) return;
    if (
      data.pauses.admin !== (pauses.admin !== null) ||
      data.pauses.billing !== (pauses.billing !== null)
    ) {
      void refreshCompany();
    }
  }, [data, pauses.admin, pauses.billing]);

  const pollBinding = useCallback(async () => {
    if (!bindingId) return;
    try {
      const { binding: next } = await apiClient.getSupplierCardBinding({ bindingId });
      setBinding(next);
    } catch (error) {
      // A trip that isn't ours or isn't there: nothing to watch.
      if (isApiError(error) && error.status === 404) {
        setBindingId(null);
        replaceRouteState(null);
      }
    }
  }, [bindingId]);

  useEffect(() => {
    void pollBinding();
  }, [pollBinding]);

  const bindingState = binding ? bindingNotice(binding) : null;
  // The subscription is made right after the first charge; the page doesn't wait for ever.
  const activating =
    bindingState?.kind === "progress" && bindingState.text === "billing.binding.activating";
  useEffect(() => {
    if (activating && activatingSince === null) setActivatingSince(Date.now());
  }, [activating, activatingSince]);
  const gaveUp = activatingSince !== null && Date.now() - activatingSince > ACTIVATION_WAIT_MS;
  const shownBinding: BindingNotice | null =
    bindingState?.kind === "progress" && activating && (data?.subscription || gaveUp)
      ? { kind: "done", withDate: data?.subscription?.status === "active" }
      : bindingState;
  const bindingWatch =
    bindingId !== null && (shownBinding === null || !bindingFinished(shownBinding));

  // A trip that ended: the address forgets it (a reload shows no stale result) and the page reads anew.
  const ended = shownBinding !== null && bindingFinished(shownBinding);
  useEffect(() => {
    if (!ended) return;
    replaceRouteState(null);
    void load();
  }, [ended, load]);

  // A charge «Оплатить сейчас» started: its result in words, as soon as there is one.
  useEffect(() => {
    if (!paying?.chargeId || !charges) return;
    const charge = charges.find((candidate) => candidate.id === paying.chargeId);
    if (!charge) return;
    if (charge.outcome === "succeeded") {
      setNotice({
        tone: "neutral",
        icon: "circleCheck",
        text: t("billing.pay.done", { date: dayText(charge.periodTo, timeZone, lang) }),
      });
      setPaying(null);
      setSettling(true);
    } else if (charge.outcome === "declined") {
      setNotice({
        tone: "danger",
        icon: "alertTriangle",
        text: t("billing.pay.declined", {
          reason: charge.declineReason ? t(declineKey(charge.declineReason)) : "—",
        }),
      });
      setPaying(null);
    } else if (charge.retryAt) {
      setNotice({ tone: "warning", icon: "clock", text: t("billing.pay.waiting") });
      setPaying(null);
    }
  }, [paying, charges, t, lang, timeZone]);

  // The payment is applied by the worker: the status follows within seconds.
  useEffect(() => {
    if (!settling) return;
    if (data?.subscription?.status === "active" && !data.pauses.billing) {
      setSettling(false);
      return;
    }
    const timer = setTimeout(() => setSettling(false), SETTLE_WAIT_MS);
    return () => clearTimeout(timer);
  }, [settling, data]);

  const processing = data?.actions.inProgress === true;
  const watching =
    bindingWatch ||
    processing ||
    paying !== null ||
    settling ||
    (data !== null && billingKind(data) === "activating");
  useVisiblePoll(
    () => {
      void load();
      void pollBinding();
    },
    POLL_MS,
    watching,
  );

  async function startBinding() {
    setActionError(null);
    setNotice(null);
    setStarting(true);
    try {
      const started = await apiClient.startSupplierCardBinding({
        returnUrl: `${window.location.origin}${routePaths.billing}`,
      });
      if (started.binding.status === "pending" && started.redirectUrl) {
        // Off to the provider's page; the browser comes back with `?binding=`.
        window.location.assign(redirectTarget(started.redirectUrl, API_URL));
        return;
      }
      // A trip already further than the page: watch it.
      setBinding(started.binding);
      setBindingId(started.binding.id);
      replaceRouteState({ binding: started.binding.id });
    } catch (error) {
      setActionError(billingErrorText(error, t));
    }
    setStarting(false);
  }

  async function payNow() {
    setActionError(null);
    setNotice(null);
    // The result of the card trip is read; the payment now says its own word.
    if (shownBinding !== null && bindingFinished(shownBinding)) {
      setBinding(null);
      setBindingId(null);
    }
    setPaying({ chargeId: null });
    try {
      const { charge } = await apiClient.payNowSupplierSubscription();
      setPaying({ chargeId: charge.id });
      setNotice({ tone: "neutral", icon: "clock", text: t("billing.pay.processing") });
      await load();
    } catch (error) {
      setActionError(billingErrorText(error, t));
      setPaying(null);
    }
  }

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await apiClient.listSupplierCharges({
        query: { limit: PAGE, cursor: nextCursor },
      });
      setCharges((current) => mergeCharges(current ?? [], page.charges));
      setNextCursor(page.nextCursor);
      loaded.current += page.charges.length;
    } catch {
      // The list on screen stays; «Показать ещё» tries again.
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <>
      <PageHeader title={t("billing.title")} back={() => goBackTo("more")} deskRoot />
      {failure !== null && !data ? (
        <ScreenError
          title={t("common.errorTitle")}
          text={t("common.errorText")}
          retry={{ label: t("common.retry"), onRetry: () => load() }}
        />
      ) : (
        <LoadingContent
          ready={data !== null}
          indicator={gate.indicator}
          skeleton={<SkeletonList rows={3} label={t("common.loading")} />}
          label={t("common.loading")}
        >
          {data && (
            <Loaded
              data={data}
              timeZone={timeZone}
              wide={wide}
              online={online}
              starting={starting}
              paying={paying !== null || processing}
              binding={shownBinding}
              notice={notice}
              actionError={actionError}
              charges={charges ?? []}
              hasMore={nextCursor !== null}
              loadingMore={loadingMore}
              onLink={startBinding}
              onPay={payNow}
              onMore={loadMore}
            />
          )}
        </LoadingContent>
      )}
    </>
  );
}

interface LoadedProps {
  data: SupplierSubscriptionResponse;
  timeZone: string;
  wide: boolean;
  online: boolean;
  starting: boolean;
  paying: boolean;
  binding: BindingNotice | null;
  notice: Notice | null;
  actionError: string | null;
  charges: SupplierCharge[];
  hasMore: boolean;
  loadingMore: boolean;
  onLink: () => void;
  onPay: () => void;
  onMore: () => void;
}

function Loaded(props: LoadedProps) {
  const { data, timeZone, online, starting, paying, binding, notice, actionError } = props;
  const { t, lang } = useLanguage();
  const kind = billingKind(data);
  const badge = stateBadge(kind);
  const actions = billingActions(data);
  const texts = stateTexts(data, timeZone, lang, t);
  const busy = starting || paying;

  return (
    <div className="page-part">
      {binding && <BindingBanner notice={binding} data={data} timeZone={timeZone} />}
      {notice && (
        <Banner tone={notice.tone} icon={notice.icon}>
          {notice.text}
        </Banner>
      )}
      {actionError && (
        <Banner tone="danger" icon="alertTriangle">
          {actionError}
        </Banner>
      )}
      {kind === "no_card" && data.cardRequired && (
        <Banner tone="warning">{t("offers.cardBanner")}</Banner>
      )}
      {data.announcedPlan && (
        <Banner tone="neutral" icon="info">
          {t("billing.tariffChange", {
            date: dayText(data.announcedPlan.validFrom, timeZone, lang),
            price: priceText(data.announcedPlan.price),
          })}
          {data.announcedPlan.notice && (
            <>
              <br />
              {data.announcedPlan.notice}
            </>
          )}
        </Banner>
      )}

      <section className="card" aria-labelledby="billing-state">
        <div className="billing-head">
          <h2 id="billing-state" className="ac-text-heading">
            {t("billing.title")}
          </h2>
          <Badge tone={badge.tone} icon={badge.icon}>
            {t(badge.text)}
          </Badge>
        </div>
        <div className="stack-s">
          {texts.map((line) => (
            <p key={line} className="ac-text-body">
              {line}
            </p>
          ))}
        </div>
        {(actions.link || actions.pay || actions.change) && (
          <ActionBar
            compact
            main={
              actions.link ? (
                <Button loading={starting} disabled={!online || busy} onClick={props.onLink}>
                  {t("billing.link")}
                </Button>
              ) : actions.pay ? (
                <Button loading={paying} disabled={!online || starting} onClick={props.onPay}>
                  {t(actions.pay === "pay" ? "billing.pay" : "billing.payNow")}
                </Button>
              ) : undefined
            }
            others={
              actions.change
                ? [
                    <Button
                      key="change"
                      variant="secondary"
                      loading={starting}
                      disabled={!online || paying}
                      onClick={props.onLink}
                    >
                      {t("billing.change")}
                    </Button>,
                  ]
                : []
            }
            note={online ? undefined : t("billing.offlineNote")}
            label={t("billing.title")}
          />
        )}
      </section>

      {data.card && (
        <section className="card" aria-labelledby="billing-card">
          <h2 id="billing-card" className="ac-text-heading">
            {t("billing.card.title")}
          </h2>
          <dl className="facts facts--rows">
            <div>
              <dt>{t("billing.card.number")}</dt>
              <dd className="num">
                {maskText(data.card)} · {t(brandKey(data.card.brand))}
              </dd>
            </div>
            <div>
              <dt>{t("billing.card.term")}</dt>
              <dd className="num">
                {termText(data.card)}
                {data.card.expired && (
                  <Badge tone="danger" icon="alertTriangle">
                    {t("billing.card.expired")}
                  </Badge>
                )}
              </dd>
            </div>
            {data.plan && (
              <div>
                <dt>{t("billing.tariff")}</dt>
                <dd className="num">
                  {t("billing.tariffNow", { price: priceText(data.plan.price) })}
                </dd>
              </div>
            )}
          </dl>
        </section>
      )}

      <h2 className="ac-text-heading section-title">{t("billing.history")}</h2>
      <History {...props} />
    </div>
  );
}

/** How the trip to the provider's page ended, in a banner. */
function BindingBanner({
  notice,
  data,
  timeZone,
}: {
  notice: BindingNotice;
  data: SupplierSubscriptionResponse;
  timeZone: string;
}) {
  const { t, lang } = useLanguage();
  switch (notice.kind) {
    case "progress":
      return (
        <Banner tone="neutral" icon="clock">
          {t(notice.text)}
        </Banner>
      );
    case "done": {
      const until = data.subscription?.periodEnd;
      const card = data.card ? maskText(data.card) : "";
      return (
        <Banner tone="neutral" icon="circleCheck">
          {notice.withDate && until
            ? t("billing.binding.doneActive", {
                card,
                date: dayText(until, timeZone, lang),
              })
            : t("billing.binding.done", { card })}
        </Banner>
      );
    }
    case "declined":
      return (
        <Banner tone="danger" icon="alertTriangle">
          {t("billing.binding.declined", {
            reason: notice.reason ? t(declineKey(notice.reason)) : "—",
          })}
        </Banner>
      );
    case "unavailable":
      return (
        <Banner tone="warning" icon="alertTriangle">
          {t("billing.binding.unavailable")}
        </Banner>
      );
    case "abandoned":
      // A company with a card was changing it: its card stays, and the words say «не заменена».
      return (
        <Banner tone="neutral">
          {t(data.card ? "billing.binding.abandonedChange" : "billing.binding.abandoned")}
        </Banner>
      );
  }
}

/** The history of charges: a table from 1024 px, cards below. */
function History({ charges, wide, hasMore, loadingMore, onMore, timeZone }: LoadedProps) {
  const { t, lang } = useLanguage();
  if (charges.length === 0) {
    return <EmptyState compact icon="receipt" title={t("billing.historyEmpty")} />;
  }
  const when = (charge: SupplierCharge) => formatDayTime(new Date(charge.at), timeZone, lang);
  const what = (charge: SupplierCharge) =>
    `${t(chargeKindKey(charge.kind))} · ${t("billing.periodTo", { date: dayText(charge.periodTo, timeZone, lang) })}`;
  const result = (charge: SupplierCharge) =>
    charge.retryAt
      ? `${chargeOutcomeText(charge, t)} · ${t("billing.outcome.retryAt", { when: formatDayTime(new Date(charge.retryAt), timeZone, lang) })}`
      : chargeOutcomeText(charge, t);
  const icon = (charge: SupplierCharge) =>
    charge.outcome === "succeeded"
      ? "circleCheck"
      : charge.outcome === "declined"
        ? "circleX"
        : "clock";

  return (
    <>
      {wide ? (
        <div className="table-wrap">
          <table className="data-table">
            <caption className="ac-visually-hidden">{t("billing.history")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("billing.table.when")}</th>
                <th scope="col">{t("billing.table.what")}</th>
                <th scope="col" className="num-col">
                  {t("billing.table.amount")}
                </th>
                <th scope="col">{t("billing.table.result")}</th>
              </tr>
            </thead>
            <tbody>
              {charges.map((charge) => (
                <tr key={charge.id}>
                  <td className="num">{when(charge)}</td>
                  <td>{what(charge)}</td>
                  <td className="num-col">{priceText(charge.amount)}</td>
                  <td>
                    <Badge tone={chargeTone(charge)} icon={icon(charge)}>
                      {result(charge)}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <ul className="billing-history">
          {charges.map((charge) => (
            <li key={charge.id} className="billing-history__row">
              <span className="billing-history__main">
                <span className="ac-text-body-strong">
                  {priceText(charge.amount)} · {when(charge)}
                </span>
                <span className="ac-text-body-s ac-muted">{what(charge)}</span>
              </span>
              <Badge tone={chargeTone(charge)} icon={icon(charge)}>
                {result(charge)}
              </Badge>
            </li>
          ))}
        </ul>
      )}
      {hasMore && (
        <div className="load-more">
          <Button variant="secondary" loading={loadingMore} onClick={onMore}>
            {t("price.showMore")}
          </Button>
        </div>
      )}
    </>
  );
}
