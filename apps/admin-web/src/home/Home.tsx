import { adminHomeCatalogFilters, type AdminHome } from "@adclub/contracts";
import { Banner, Button, Icon, LoadingContent, Skeleton } from "@adclub/ui";
import type { IconName } from "@adclub/ui-core";
import type { ReactNode } from "react";
import { apiClient } from "../api";
import { loadErrorText } from "../errors";
import { formatMoment } from "../format";
import { itemsLink } from "../catalog/item-filters";
import { navigateTo, orderExtensionsPath, routePaths, withQuery } from "../router";
import { count, KIND_HINTS, KIND_TITLES } from "../signals/signal-words";
import { useLoad } from "../use-load";

/**
 * A-HOME — the queue of attention (SCREENS 7.1; TASK-034 requirement 3): the
 * cards in the order of importance, every counter from one answer of the
 * server (`GET /admin/home`). A card leads to its list; a list of the next
 * tasks opens its honest «появится», the number on the card is true all the
 * same. Reviews, moderation, complaints and payments come with stages C–D.
 */
export function Home() {
  const home = useLoad(() => apiClient.getAdminHome(), "home");
  const data = home.data;

  return (
    <>
      <div className="page__head">
        <h1 className="ac-text-title-l page__title">Очередь внимания</h1>
        <div className="page__tools">
          {data && (
            <span className="ac-text-caption ac-muted">Данные на {formatMoment(data.at)}</span>
          )}
          <Button variant="secondary" size="s" icon="refresh" onClick={home.reload}>
            Обновить
          </Button>
        </div>
      </div>
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
        {data && <Cards home={data} />}
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
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="home-card">
          <Skeleton width="60%" />
          <Skeleton width={64} height={32} />
          <Skeleton width="90%" height={12} />
        </div>
      ))}
    </div>
  );
}

function Cards({ home }: { home: AdminHome }) {
  const signal = (kind: AdminHome["signals"][number]["kind"]) =>
    home.signals.find((row) => row.kind === kind) ?? { open: 0, acknowledged: 0 };
  const outage = home.channelOutage;
  const quality = home.catalog;

  return (
    <div className="home-sections">
      <section aria-labelledby="home-channel" className="home-section">
        <h2 id="home-channel" className="ac-text-heading">
          1. Канал уведомлений
        </h2>
        {outage ? (
          <div className="home-outage" role="alert">
            <div className="home-outage__head">
              <Icon name="alertTriangle" size={24} />
              <h3 className="ac-text-title">Сбой канала уведомлений</h3>
            </div>
            <p className="ac-text-body">
              С {formatMoment(outage.since)}:{" "}
              {count(outage.affectedOrders, "заявка", "заявки", "заявок")} без уведомления
              поставщику, не дошло{" "}
              {count(outage.failedMessages, "уведомление", "уведомления", "уведомлений")}.{" "}
              {KIND_HINTS.whatsapp_outage}
            </p>
            <div className="button-row">
              <Button
                size="s"
                onClick={() => navigateTo(orderExtensionsPath(outage.since ?? undefined))}
              >
                Продлить сроки
              </Button>
              <Button
                variant="secondary"
                size="s"
                onClick={() =>
                  navigateTo(withQuery(routePaths.signals, { kind: "whatsapp_outage" }))
                }
              >
                Открыть сигнал
              </Button>
            </div>
          </div>
        ) : (
          <p className="home-calm ac-text-body-s">
            <Icon name="circleCheck" size={20} /> Сбоя нет: уведомления поставщикам доходят.
          </p>
        )}
      </section>

      <section aria-labelledby="home-signals" className="home-section">
        <h2 id="home-signals" className="ac-text-heading">
          2. Сигналы
        </h2>
        <div className="home-grid">
          {(
            [
              "supplier_unreachable",
              "supply_overdue",
              "visit_unresolved",
              "duplicate_after_late_close",
              "frequent_admin_closes",
            ] as const
          ).map((kind) => {
            const { open, acknowledged } = signal(kind);
            return (
              <Card
                key={kind}
                icon="alertTriangle"
                title={KIND_TITLES[kind]}
                value={open + acknowledged}
                tone={open > 0 ? "attention" : "plain"}
                note={
                  acknowledged > 0 ? `новых ${open}, в работе ${acknowledged}` : KIND_HINTS[kind]
                }
                onOpen={() => navigateTo(withQuery(routePaths.signals, { kind }))}
              />
            );
          })}
          <Card
            icon="sparkles"
            title="Бюджет ИИ на сегодня"
            value={home.aiBudget.exhausted ? "Исчерпан" : "В пределах"}
            tone={home.aiBudget.exhausted ? "attention" : "plain"}
            note={`Потрачено $${home.aiBudget.spentUsd.toFixed(2)} из $${home.aiBudget.budgetUsd.toFixed(2)} (сутки по Алматы). Предел — настройка ai_daily_budget_usd.`}
            onOpen={() => navigateTo(withQuery(routePaths.settings, { q: "ai_daily_budget_usd" }))}
          />
        </div>
      </section>

      <section aria-labelledby="home-leads" className="home-section">
        <h2 id="home-leads" className="ac-text-heading">
          3. Новые заявки на подключение
        </h2>
        <div className="home-grid">
          <Card
            icon="store"
            title="Поставщики ждут ответа"
            value={home.newSupplierLeads}
            tone={home.newSupplierLeads > 0 ? "attention" : "plain"}
            note="Заявки с формы на сайте и добавленные вручную на этапе «Новая»"
            onOpen={() => navigateTo(withQuery(routePaths.supplierLeads, { status: "new" }))}
          />
        </div>
      </section>

      <section aria-labelledby="home-catalog" className="home-section">
        <h2 id="home-catalog" className="ac-text-heading">
          4. Качество справочника
        </h2>
        <div className="home-grid">
          <Card
            icon="package"
            title="Без фото"
            value={quality.withoutPhoto}
            note="Активные позиции без подтверждённого фото"
            onOpen={() => navigateTo(itemsLink(adminHomeCatalogFilters.withoutPhoto))}
          />
          <Card
            icon="checklist"
            title="Неполные характеристики"
            value={quality.incomplete}
            note="Активные позиции, у которых не заполнены обязательные характеристики"
            onOpen={() => navigateTo(itemsLink(adminHomeCatalogFilters.incomplete))}
          />
          <Card
            icon="car"
            title="Без совместимости"
            value={quality.withoutCompatibility}
            note="Позиции категорий с обязательной совместимостью: клиенты их не видят"
            onOpen={() => navigateTo(itemsLink(adminHomeCatalogFilters.withoutCompatibility))}
          />
          <Card
            icon="language"
            title="Без перевода"
            value={quality.itemsWithoutTranslation}
            note={`Активные позиции, у которых название без казахского или английского перевода (нет или отказ). Всего текстов справочника без перевода, с категориями и характеристиками: ${quality.withoutTranslation.toLocaleString("ru-RU")}`}
            onOpen={() => navigateTo(itemsLink(adminHomeCatalogFilters.itemsWithoutTranslation))}
          />
        </div>
      </section>
    </div>
  );
}

function Card({
  icon,
  title,
  value,
  note,
  tone = "plain",
  onOpen,
}: {
  icon: IconName;
  title: string;
  value: number | string;
  note: ReactNode;
  tone?: "plain" | "attention";
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className={tone === "attention" ? "home-card home-card--attention" : "home-card"}
      onClick={onOpen}
    >
      <span className="home-card__title">
        <Icon name={icon} size={20} />
        <span className="ac-text-body-strong">{title}</span>
      </span>
      <span className="home-card__value num">
        {typeof value === "number" ? value.toLocaleString("ru-RU") : value}
      </span>
      <span className="ac-text-caption ac-muted">{note}</span>
    </button>
  );
}
