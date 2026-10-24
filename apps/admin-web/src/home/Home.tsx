import { adminHomeCatalogFilters, type AdminHome } from "@adclub/contracts";
import { ActionBar, Banner, Button, Icon, IconButton, LoadingContent, Skeleton } from "@adclub/ui";
import type { IconName } from "@adclub/ui-core";
import { apiClient } from "../api";
import { itemsLink } from "../catalog/item-filters";
import { loadErrorText } from "../errors";
import { formatMoment } from "../format";
import { AppLink, Header } from "../layout/layout";
import { navigateTo, orderExtensionsPath, routePaths, withQuery } from "../router";
import { count, KIND_HINTS, KIND_TITLES } from "../signals/signal-words";
import { useLoad } from "../use-load";

/** A card of the queue: what it counts, where it leads. */
export interface HomeCard {
  key: string;
  icon: IconName;
  title: string;
  value: number;
  note: string;
  href: string;
}

const SIGNAL_KINDS = [
  "supplier_unreachable",
  "supply_overdue",
  "visit_unresolved",
  "low_rating",
  "duplicate_after_late_close",
  "frequent_admin_closes",
] as const;

/**
 * The cards of A-HOME in the order of importance of SCREENS 7.1 —
 * signals, reviews on check, moderation, complaints, connection requests,
 * the quality of the catalog — every counter from one answer of the server.
 */
export function homeCards(home: AdminHome): HomeCard[] {
  const signal = (kind: (typeof SIGNAL_KINDS)[number]) => {
    const row = home.signals.find((entry) => entry.kind === kind);
    return (row?.open ?? 0) + (row?.acknowledged ?? 0);
  };
  const quality = home.catalog;
  return [
    ...SIGNAL_KINDS.map((kind) => ({
      key: kind,
      icon: "alertTriangle" as const,
      title: KIND_TITLES[kind],
      value: signal(kind),
      note: KIND_HINTS[kind],
      href: withQuery(routePaths.signals, { kind }),
    })),
    {
      key: "reviews",
      icon: "star",
      title: "Отзывы на проверке",
      value: home.reviewsHeld,
      note: "Проверка задержала текст или не смогла его проверить: опубликовать или отклонить текст",
      href: routePaths.reviews,
    },
    {
      key: "requests",
      icon: "checklist",
      title: "Запросы на позиции",
      value: home.catalogRequests,
      note: "Строк прайсов нет в справочнике: создать позицию, указать существующую или отклонить",
      href: withQuery(routePaths.catalogRequests, { status: "new" }),
    },
    {
      key: "complaints",
      icon: "alertTriangle",
      title: "Новые жалобы",
      value: home.complaintsNew,
      note: "Жалобы пользователей по заявкам, ещё не взятые в работу",
      href: withQuery(routePaths.complaints, { status: "new" }),
    },
    {
      key: "leads",
      icon: "store",
      title: "Поставщики ждут ответа",
      value: home.newSupplierLeads,
      note: "Заявки на подключение на этапе «Новая» — с сайта и добавленные вручную",
      href: withQuery(routePaths.supplierLeads, { status: "new" }),
    },
    {
      key: "withoutPhoto",
      icon: "image",
      title: "Без фото",
      value: quality.withoutPhoto,
      note: "Активные позиции без подтверждённого фото",
      href: itemsLink(adminHomeCatalogFilters.withoutPhoto),
    },
    {
      key: "incomplete",
      icon: "checklist",
      title: "Неполные характеристики",
      value: quality.incomplete,
      note: "Не заполнены обязательные характеристики",
      href: itemsLink(adminHomeCatalogFilters.incomplete),
    },
    {
      key: "withoutCompatibility",
      icon: "car",
      title: "Без совместимости",
      value: quality.withoutCompatibility,
      note: "Категории с обязательной совместимостью: клиенты эти позиции не видят",
      href: itemsLink(adminHomeCatalogFilters.withoutCompatibility),
    },
    {
      key: "withoutTranslation",
      icon: "language",
      title: "Без перевода",
      value: quality.itemsWithoutTranslation,
      note: `Названия позиций без казахского или английского перевода; всего текстов справочника без перевода — ${quality.withoutTranslation.toLocaleString("ru-RU")}`,
      href: itemsLink(adminHomeCatalogFilters.itemsWithoutTranslation),
    },
  ];
}

/** «$0,18» — dollars of the AI budget, as people read them. */
function dollars(value: number): string {
  return `$${value.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * A-HOME — the queue of attention (SCREENS 7.1; TASK-034, TASK-080): the
 * outage of the channel on top when there is one; then the cards that need
 * someone — their number not zero — in the order of importance, equal in
 * height, the number at one height; everything at zero in one line «Без
 * внимания: …» with a check; the AI budget of today as «$0,18 из $100»
 * with its bar and the setting it comes from.
 */
export function Home() {
  const home = useLoad(() => apiClient.getAdminHome(), "home");
  const data = home.data;

  return (
    <>
      <Header
        title="Главная"
        subtitle={
          data ? `Очередь внимания · данные на ${formatMoment(data.at)}` : "Очередь внимания"
        }
        actions={<IconButton icon="refresh" label="Обновить" size={20} onClick={home.reload} />}
      />
      <LoadingContent
        ready={data !== undefined}
        indicator={home.indicator}
        label="Загрузка"
        skeleton={<HomeSkeleton />}
        notice={
          home.error !== undefined && data !== undefined ? (
            <Banner
              tone="danger"
              action={
                <Button variant="text" size="s" onClick={home.reload}>
                  Повторить
                </Button>
              }
            >
              {loadErrorText(home.error)}. Показаны прежние данные.
            </Banner>
          ) : undefined
        }
      >
        {data && <Queue home={data} />}
      </LoadingContent>
      {home.error !== undefined && data === undefined && (
        <Banner
          tone="danger"
          action={
            <Button variant="text" size="s" onClick={home.reload}>
              Повторить
            </Button>
          }
        >
          {loadErrorText(home.error)}
        </Banner>
      )}
    </>
  );
}

function HomeSkeleton() {
  return (
    <div className="home-grid" aria-label="Загрузка">
      {Array.from({ length: 4 }, (_, index) => (
        <div key={index} className="home-card">
          <Skeleton width="60%" />
          <Skeleton width={64} height={34} />
          <Skeleton width="90%" height={12} />
        </div>
      ))}
    </div>
  );
}

function Queue({ home }: { home: AdminHome }) {
  const outage = home.channelOutage;
  const cards = homeCards(home);
  const attention = cards.filter((card) => card.value > 0);
  const calm = cards.filter((card) => card.value === 0);
  const budget = home.aiBudget;
  const share = budget.budgetUsd > 0 ? Math.min(1, budget.spentUsd / budget.budgetUsd) : 1;

  return (
    <div className="home-sections">
      {outage && (
        <section className="home-outage" role="alert" aria-labelledby="home-outage">
          <div className="home-outage__head">
            <Icon name="alertTriangle" size={24} />
            <h2 id="home-outage" className="ac-text-title">
              Сбой канала уведомлений
            </h2>
          </div>
          <p className="ac-text-body">
            С {formatMoment(outage.since)}:{" "}
            {count(outage.affectedOrders, "заявка", "заявки", "заявок")} без уведомления поставщику,
            не дошло {count(outage.failedMessages, "уведомление", "уведомления", "уведомлений")}.{" "}
            {KIND_HINTS.whatsapp_outage}
          </p>
          <ActionBar
            compact
            label="Сбой канала"
            main={
              <Button onClick={() => navigateTo(orderExtensionsPath(outage.since ?? undefined))}>
                Продлить сроки
              </Button>
            }
            others={[
              <Button
                key="signal"
                variant="secondary"
                onClick={() =>
                  navigateTo(withQuery(routePaths.signals, { kind: "whatsapp_outage" }))
                }
              >
                Открыть сигнал
              </Button>,
            ]}
          />
        </section>
      )}

      {attention.length > 0 && (
        <section aria-label="Требует внимания" className="home-grid">
          {attention.map((card) => (
            <a
              key={card.key}
              href={card.href}
              className="home-card home-card--attention"
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
              <span className="home-card__value">{card.value.toLocaleString("ru-RU")}</span>
              <span className="home-card__note">{card.note}</span>
            </a>
          ))}
        </section>
      )}

      <section aria-labelledby="home-budget" className="home-budget">
        <span className="home-budget__head">
          <Icon name="sparkles" size={20} />
          <h2 id="home-budget" className="home-card__name">
            Бюджет ИИ на сегодня
          </h2>
          {budget.exhausted && <span className="warning-text">исчерпан</span>}
        </span>
        <span className="home-budget__value">
          {dollars(budget.spentUsd)} из {dollars(budget.budgetUsd)}
        </span>
        <span
          className={
            budget.exhausted ? "home-budget__bar home-budget__bar--over" : "home-budget__bar"
          }
          role="meter"
          aria-label="Потрачено из дневного предела"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(share * 100)}
        >
          <span style={{ width: `${String(Math.round(share * 100))}%` }} />
        </span>
        <span className="home-card__note">
          Сутки по Алматы.{" "}
          <AppLink href={withQuery(routePaths.settings, { group: "ai" })}>
            Настройка предела
          </AppLink>
        </span>
      </section>

      {calm.length > 0 && (
        <p className="home-calm">
          <Icon name="circleCheck" size={20} />
          <span>
            <span className="home-calm__label">Без внимания:</span>{" "}
            {!outage && "канал уведомлений работает, "}
            {calm.map((card, index) => (
              <span key={card.key}>
                <AppLink href={card.href}>{card.title}</AppLink>
                {index < calm.length - 1 ? ", " : ""}
              </span>
            ))}
          </span>
        </p>
      )}
    </div>
  );
}
