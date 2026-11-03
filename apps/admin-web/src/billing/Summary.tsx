import type { AdminBillingSummary } from "@adclub/contracts";
import { Banner, Button, Icon, IconButton, LoadingContent, Skeleton } from "@adclub/ui";
import type { IconName } from "@adclub/ui-core";
import { apiClient } from "../api";
import { loadErrorText } from "../errors";
import { formatDay, formatMoment } from "../format";
import { AppLink, Header } from "../layout/layout";
import { Period } from "../orders/Orders";
import { navigateTo, routePaths, withQuery } from "../router";
import { useAddressFilters } from "../suppliers/shared";
import { amountText } from "../suppliers/billing-words";
import { useLoad } from "../use-load";
import {
  billingTabs,
  chargesPath,
  GROUP_HINT,
  GROUP_TEXT,
  paymentsPath,
  periodOf,
  planLine,
  withPeriod,
} from "./billing-words";
import "./billing.css";

interface Card {
  key: string;
  icon: IconName;
  title: string;
  value: number;
  note: string;
  href: string;
  /** A sum under the number (the charges). */
  extra?: string;
}

/**
 * The cards of A-BILL-01, each with the list it opens — **the list's own
 * filters, the very ones the server counted the number with** (I847): the
 * number on a card is the «Всего» of the page it opens.
 */
export function summaryCards(
  summary: AdminBillingSummary,
  days: { fromDay: string; toDay: string },
): { users: Card[]; suppliers: Card[]; charges: Card[] } {
  const users = (values: Record<string, string>) => withQuery(routePaths.billingUsers, values);
  const groups = summary.suppliers;
  return {
    users: [
      {
        key: "active",
        icon: "users",
        title: "Действующие подписки",
        value: summary.users.active.total,
        note: "Дают клубный доступ сейчас; выдача доступа вручную не считается",
        href: users({ tab: "active" }),
      },
      {
        key: "ios",
        icon: "users",
        title: "iOS",
        value: summary.users.active.ios,
        note: "Действующие, куплены в App Store",
        href: users({ tab: "active", platform: "ios" }),
      },
      {
        key: "android",
        icon: "users",
        title: "Android",
        value: summary.users.active.android,
        note: "Действующие, куплены в Google Play",
        href: users({ tab: "active", platform: "android" }),
      },
      {
        key: "other",
        icon: "users",
        title: "Прочие",
        value: summary.users.active.other,
        note: "Действующие, платформа не указана",
        href: users({ tab: "active", platform: "other" }),
      },
      {
        key: "started",
        icon: "plus",
        title: "Новые за период",
        value: summary.users.started,
        note: "Первое оформление подписки попало в период",
        href: users({ tab: "all", startedFrom: days.fromDay, startedTo: days.toDay }),
      },
      {
        key: "ended",
        icon: "clock",
        title: "Прекращённые за период",
        value: summary.users.ended,
        note: "Закончились, возврат денег или отзыв покупки в периоде",
        href: users({ tab: "ended", endedFrom: days.fromDay, endedTo: days.toDay }),
      },
    ],
    suppliers: [
      {
        key: "paid",
        icon: "circleCheck",
        title: GROUP_TEXT.paid,
        value: groups.paid,
        note: GROUP_HINT.paid,
        href: paymentsPath(["paid"]),
      },
      {
        key: "problem",
        icon: "alertTriangle",
        title: "Проблема с оплатой",
        value: groups.declined + groups.awaitingProvider,
        note: `${GROUP_TEXT.declined}: ${groups.declined.toLocaleString("ru-RU")}, ${GROUP_TEXT.awaiting_provider.toLowerCase()}: ${groups.awaitingProvider.toLocaleString("ru-RU")}`,
        href: paymentsPath(["declined", "awaiting_provider"]),
      },
      {
        key: "paused",
        icon: "pause",
        title: GROUP_TEXT.paused,
        value: groups.paused,
        note: GROUP_HINT.paused,
        href: paymentsPath(["paused"]),
      },
      {
        key: "none",
        icon: "creditCard",
        title: GROUP_TEXT.none,
        value: groups.none,
        note: GROUP_HINT.none,
        href: paymentsPath(["none"]),
      },
    ],
    charges: [
      {
        key: "succeeded",
        icon: "creditCard",
        title: "Успешные списания",
        value: summary.charges.succeeded.count,
        extra: amountText(summary.charges.succeeded.amount),
        note: "Списания поставщиков за период",
        href: chargesPath({ from: days.fromDay, to: days.toDay, status: "succeeded" }),
      },
      {
        key: "declined",
        icon: "alertTriangle",
        title: "Отказы банка",
        value: summary.charges.declined.count,
        note: "Неуспешные списания за период",
        href: chargesPath({ from: days.fromDay, to: days.toDay, status: "declined" }),
      },
    ],
  };
}

function CardLink({ card }: { card: Card }) {
  return (
    <a
      href={card.href}
      className="home-card"
      title={card.note}
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        navigateTo(card.href);
      }}
    >
      <span className="home-card__title">
        <Icon name={card.icon} size={20} />
        <span className="home-card__name">{card.title}</span>
      </span>
      <span className="home-card__value">
        {card.value.toLocaleString("ru-RU")}
        {card.extra && <span className="billing-card__extra">{card.extra}</span>}
      </span>
      <span className="home-card__note">{card.note}</span>
    </a>
  );
}

/**
 * A-BILL-01 «Сводка» (SCREENS 7.8; TASK-043): users' subscriptions giving
 * access now by platform, started and ended in the period; suppliers in
 * their one group each; the charges of the period; the suppliers' tariff
 * and its next change. The period — days of Almaty in the address, the
 * last 30 days by default — as in «Заявки».
 */
export function BillingSummary() {
  const { query, set } = useAddressFilters();
  const period = periodOf(query);
  const summary = useLoad(
    () => apiClient.getAdminBillingSummary({ query: { from: period.from, to: period.to } }),
    `${period.from}|${period.to}`,
  );
  const data = summary.data;
  const cards = data ? summaryCards(data, period) : null;

  return (
    <>
      <Header
        title="Биллинг"
        tabs={billingTabs("summary")}
        subtitle={data ? `Данные на ${formatMoment(data.at)}` : undefined}
        actions={<IconButton icon="refresh" label="Обновить" size={20} onClick={summary.reload} />}
      />
      <div className="filters__group">
        <div className="filters">
          <Period
            from={period.fromDay}
            to={period.toDay}
            onChange={(patch) => set({ ...{ from: period.fromDay, to: period.toDay }, ...patch })}
          />
        </div>
      </div>
      {summary.error !== undefined && (
        <Banner
          tone="danger"
          action={
            <Button variant="text" size="s" onClick={summary.reload}>
              Повторить
            </Button>
          }
        >
          {loadErrorText(summary.error)}
          {data ? ". Показаны прежние данные." : ""}
        </Banner>
      )}
      <LoadingContent
        ready={data !== undefined}
        indicator={summary.indicator}
        label="Загрузка"
        skeleton={<SummarySkeleton />}
      >
        {data && cards && (
          <div className="billing-sections">
            <section aria-labelledby="billing-plan" className="billing-plan">
              <h2 id="billing-plan" className="ac-text-title-s">
                Тариф поставщиков
              </h2>
              {data.supplierPlan.inEffect ? (
                <p className="ac-text-body">
                  Сейчас — {amountText(data.supplierPlan.inEffect.price)} в месяц (с{" "}
                  {formatDay(data.supplierPlan.inEffect.validFrom)}).
                  {data.supplierPlan.next && (
                    <>
                      {" "}
                      {planLine(data.supplierPlan.next)}
                      {data.supplierPlan.next.state === "announced"
                        ? " — поставщики уже видят это."
                        : withPeriod(
                            `; поставщики увидят это с ${formatDay(data.supplierPlan.next.announceFrom)}`,
                          )}
                    </>
                  )}{" "}
                  <AppLink href={routePaths.billingPlans}>Тарифы</AppLink>
                </p>
              ) : (
                <Banner
                  tone="warning"
                  action={
                    <Button
                      variant="text"
                      size="s"
                      onClick={() => navigateTo(routePaths.billingPlans)}
                    >
                      Тарифы
                    </Button>
                  }
                >
                  Тариф поставщиков не задан: подписку нельзя начать и продлить
                </Banner>
              )}
            </section>
            <CardSection id="billing-users" title="Подписки пользователей" cards={cards.users} />
            <CardSection id="billing-suppliers" title="Поставщики" cards={cards.suppliers} />
            <CardSection
              id="billing-charges"
              title={`Списания с ${formatDay(period.from)} по ${formatDay(new Date(new Date(period.to).getTime() - 1).toISOString())}`}
              cards={cards.charges}
            />
          </div>
        )}
      </LoadingContent>
    </>
  );
}

function CardSection({ id, title, cards }: { id: string; title: string; cards: Card[] }) {
  return (
    <section aria-labelledby={id}>
      <h2 id={id} className="ac-text-title-s billing-section__title">
        {title}
      </h2>
      <div className="home-grid">
        {cards.map((card) => (
          <CardLink key={card.key} card={card} />
        ))}
      </div>
    </section>
  );
}

function SummarySkeleton() {
  return (
    <div className="home-grid" aria-label="Загрузка">
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="home-card">
          <Skeleton width="60%" />
          <Skeleton width={64} height={34} />
          <Skeleton width="90%" height={12} />
        </div>
      ))}
    </div>
  );
}
