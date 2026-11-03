import type { AdminSupplierBillingResponse } from "@adclub/contracts";
import { Badge, EmptyState, LoadingContent, SkeletonList, StatusBadge } from "@adclub/ui";
import { apiClient } from "../api";
import { formatDay, formatMoment } from "../format";
import { chargesPath } from "../billing/billing-words";
import { AppLink, Muted, Table } from "../layout/layout";
import { useLoad } from "../use-load";
import {
  SUBSCRIPTION_BY_TEXT,
  SUBSCRIPTION_EVENT_TEXT,
  SUBSCRIPTION_STATUS_TEXT,
  outcomeText,
} from "../users/subscription-words";
import { LoadError } from "../vehicles/shared";
import {
  amountText,
  cardLine,
  CHARGE_KIND_TEXT,
  chargeOutcomeText,
  DECLINE_REASON_TEXT,
  pauseLines,
  SUPPLIER_SUBSCRIPTION_TEXT,
  termText,
} from "./billing-words";

/**
 * A-SUP-03 «Подписка» (TASK-042; PRODUCT 14.1, 14.3; ARCHITECTURE 9.4.2,
 * 18.5): the company's card subscription as the server holds it — the status
 * in words, paid until, when the card is charged next, the card (the mask
 * only: the token is a secret nobody sees), **both pauses side by side** (the
 * administrator's and the one for the unpaid subscription — lifting one
 * never lifts the other), the latest charges and the events of the
 * subscription. Read only: the screens of the billing as a whole are
 * TASK-043, and the pause is lifted in «Статусы» (the administrator's) or by
 * a payment (the billing one).
 */
export function SupplierBilling({ supplierId }: { supplierId: string }) {
  const loaded = useLoad<AdminSupplierBillingResponse>(
    () => apiClient.getAdminSupplierBilling({ supplierId }),
    `supplier-billing:${supplierId}`,
  );
  const data = loaded.data;
  return (
    <div className="detail-stack">
      <LoadError error={loaded.error} retry={loaded.reload} />
      <LoadingContent
        ready={data !== undefined}
        indicator={loaded.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={4} label="Загрузка" />}
      >
        {data && <Loaded supplierId={supplierId} data={data} />}
      </LoadingContent>
    </div>
  );
}

function Loaded({ supplierId, data }: { supplierId: string; data: AdminSupplierBillingResponse }) {
  const { subscription, card, pauses, charges, history } = data;
  const lines = pauseLines(pauses);
  return (
    <>
      <section className="section" aria-labelledby="billing-state-title">
        <div className="section__head">
          <h2 id="billing-state-title" className="section__title">
            Подписка
          </h2>
        </div>
        {!subscription ? (
          <EmptyState
            compact
            icon="creditCard"
            title="Подписки нет"
            text="Поставщик ещё не привязывал карту или подписка закончилась"
          />
        ) : (
          <div className="card">
            <dl className="kv">
              <dt>Статус</dt>
              <dd>
                <StatusBadge kind="subscription" status={subscription.status}>
                  {SUPPLIER_SUBSCRIPTION_TEXT[subscription.status]}
                </StatusBadge>
              </dd>
              <dt>Оплачено до</dt>
              <dd>{formatDay(subscription.periodEnd)}</dd>
              {subscription.graceUntil && (
                <>
                  <dt>Повторы до</dt>
                  <dd>
                    {formatMoment(subscription.graceUntil)}
                    <span className="kv__note">после этого — пауза по оплате</span>
                  </dd>
                </>
              )}
              <dt>Следующее списание</dt>
              <dd>
                {subscription.nextChargeAt ? (
                  formatMoment(subscription.nextChargeAt)
                ) : (
                  <Muted>не запланировано</Muted>
                )}
              </dd>
              <dt>Следующий срок</dt>
              <dd>{subscription.amount !== null ? amountText(subscription.amount) : "—"}</dd>
              {subscription.lastDecline && (
                <>
                  <dt>Последний отказ</dt>
                  <dd>
                    {formatMoment(subscription.lastDecline.at)}
                    <span className="kv__note">
                      {DECLINE_REASON_TEXT[subscription.lastDecline.reason]}
                    </span>
                  </dd>
                </>
              )}
              <dt>Тариф</dt>
              <dd>
                {data.plan ? `${amountText(data.plan.price)} в месяц` : <Muted>не задан</Muted>}
                {data.announcedPlan && (
                  <span className="kv__note">
                    С {formatDay(data.announcedPlan.validFrom)} —{" "}
                    {amountText(data.announcedPlan.price)} в месяц
                  </span>
                )}
              </dd>
            </dl>
          </div>
        )}
      </section>

      <section className="section" aria-labelledby="billing-card-title">
        <div className="section__head">
          <h2 id="billing-card-title" className="section__title">
            Карта
          </h2>
        </div>
        {!card ? (
          <EmptyState
            compact
            icon="creditCard"
            title="Карта не привязана"
            text="Токен карты у нас не виден никому; показывается только маска"
          />
        ) : (
          <div className="card">
            <dl className="kv">
              <dt>Карта</dt>
              <dd>{cardLine(card)}</dd>
              <dt>Срок действия</dt>
              <dd className="badges">
                {termText(card)}
                {card.expired && (
                  <Badge tone="danger" icon="alertTriangle">
                    срок истёк
                  </Badge>
                )}
              </dd>
              <dt>Привязана</dt>
              <dd>{formatMoment(card.linkedAt)}</dd>
            </dl>
          </div>
        )}
      </section>

      <section className="section" aria-labelledby="billing-pauses-title">
        <div className="section__head">
          <h2 id="billing-pauses-title" className="section__title">
            Паузы
          </h2>
        </div>
        <div className="card">
          <dl className="kv">
            <dt>Администратора</dt>
            <dd>{lines.admin ?? <Muted>нет</Muted>}</dd>
            <dt>По оплате</dt>
            <dd>
              {lines.billing ?? <Muted>нет</Muted>}
              {pauses.billing && pauses.admin && (
                <span className="kv__note">
                  Обе паузы держатся отдельно: оплата снимает только паузу по оплате, пауза
                  администратора остаётся
                </span>
              )}
            </dd>
          </dl>
        </div>
      </section>

      <section className="section" aria-labelledby="billing-charges-title">
        <div className="section__head">
          <h2 id="billing-charges-title" className="section__title">
            Списания
          </h2>
          <AppLink href={chargesPath({ supplierId })}>Все платежи</AppLink>
        </div>
        {charges.length === 0 ? (
          <EmptyState compact icon="receipt" title="Списаний пока не было" />
        ) : (
          <Table
            label="Списания"
            columns={[
              { key: "at", header: "Когда", width: 150 },
              { key: "what", header: "За что" },
              { key: "amount", header: "Сумма", width: 110, numeric: true },
              { key: "result", header: "Итог", width: 340 },
            ]}
          >
            {charges.map((charge) => (
              <tr key={charge.id}>
                <td className="ac-text-body-s nowrap">{formatMoment(charge.at)}</td>
                <td className="ac-text-body-s">
                  <span className="cell-stack">
                    <span>{CHARGE_KIND_TEXT[charge.kind]}</span>
                    <span className="ac-text-caption ac-muted">
                      срок до {formatDay(charge.periodTo)}
                    </span>
                  </span>
                </td>
                <td className="ac-text-body-s num">{amountText(charge.amount)}</td>
                <td className="ac-text-body-s">
                  <Badge
                    tone={
                      charge.outcome === "succeeded"
                        ? "success"
                        : charge.outcome === "declined"
                          ? "danger"
                          : "neutral"
                    }
                    icon={
                      charge.outcome === "succeeded"
                        ? "circleCheck"
                        : charge.outcome === "declined"
                          ? "circleX"
                          : "clock"
                    }
                  >
                    {chargeOutcomeText(charge)}
                  </Badge>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </section>

      <section className="section" aria-labelledby="billing-events-title">
        <div className="section__head">
          <h2 id="billing-events-title" className="section__title">
            События подписки
          </h2>
        </div>
        {history.length === 0 ? (
          <EmptyState compact icon="history" title="Событий пока не было" />
        ) : (
          <Table
            label="События подписки"
            columns={[
              { key: "event", header: "Событие" },
              { key: "at", header: "Когда", width: 150 },
              { key: "status", header: "Статус", width: 300 },
              { key: "outcome", header: "Итог", width: 260 },
            ]}
          >
            {history.map((entry) => (
              <tr key={entry.id}>
                <td className="ac-text-body-s">
                  <span className="cell-stack">
                    <span>{SUBSCRIPTION_EVENT_TEXT[entry.kind] ?? entry.kind}</span>
                    <span className="ac-text-caption ac-muted">
                      {SUBSCRIPTION_BY_TEXT[entry.by]}
                      {entry.periodEnd && `, до ${formatDay(entry.periodEnd)}`}
                    </span>
                  </span>
                </td>
                <td className="ac-text-body-s nowrap">{formatMoment(entry.eventAt)}</td>
                <td className="ac-text-body-s">
                  {entry.toStatus && entry.fromStatus !== entry.toStatus ? (
                    <>
                      {entry.fromStatus && (
                        <Muted>{SUBSCRIPTION_STATUS_TEXT[entry.fromStatus]} → </Muted>
                      )}
                      {SUBSCRIPTION_STATUS_TEXT[entry.toStatus]}
                    </>
                  ) : (
                    <Muted>—</Muted>
                  )}
                </td>
                <td className="ac-text-body-s">{outcomeText(entry)}</td>
              </tr>
            ))}
          </Table>
        )}
      </section>
    </>
  );
}
