import type { AdminOrder, AdminOrderResponse, DisciplineMark } from "@adclub/contracts";
import { Banner, Button, IconButton, LoadingContent, SkeletonList, useToast } from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useState } from "react";
import { apiClient } from "../api";
import { JournalHistory } from "../audit/JournalHistory";
import { AppLink } from "../catalog/shared";
import { formatMoment } from "../format";
import { PhoneReveal } from "../people/PhoneReveal";
import { useAdminNames } from "../people/use-admin-names";
import { goBack, orderPath, supplierPath, userPath } from "../router";
import { ReasonDialog, WasNow } from "../suppliers/shared";
import { useLoad } from "../use-load";
import { LoadError } from "../vehicles/shared";
import {
  CANCEL_TEXT,
  channelText,
  CLOSE_WITHOUT_CODE_TEXT,
  DECLINE_REASON_TEXT,
  eventText,
  FULFILLMENT_TEXT,
  moneyText,
  ORDER_STATUS_TEXT,
  orderActions,
  orderActorText,
  orderErrorText,
  orderKindText,
  orderStatusText,
  orderTermLines,
  statusTone,
} from "./order-words";

type Action = "extendResponse" | "extendReserve" | "extendTerm" | "close" | "cancel";

/** The steps an extension offers, minutes (the server caps one at `deadline_extension_max_hours`). */
const MINUTES = [15, 30, 60, 120, 240, 480, 1440] as const;

function minutesText(minutes: number): string {
  if (minutes < 60) return `${minutes} мин`;
  if (minutes % 1440 === 0) return `${minutes / 1440} сут`;
  return `${minutes / 60} ч`;
}

/**
 * A-ORD-02 «Карточка заявки» (SCREENS 7.5; TASK-036.B): the item, the
 * quantity and the sum, the customer (the number partly hidden, «Показать
 * номер» with a trace), the supplier, the way it is received, the
 * deadlines, the journal of the order with who did what — an employee, an
 * administrator, the system, «через WhatsApp» — and when. The manual
 * actions, each with a reason and «было → стало»: extend the answer
 * deadline or the reserve, close without a code, cancel, lift a discipline
 * mark — offered only where the one table of moves allows them; the server
 * decides again. Never the code or the QR.
 */
export function OrderCard({ orderId }: { orderId: string }) {
  const toast = useToast();
  const online = useOnline();
  const admins = useAdminNames();
  const card = useLoad<AdminOrderResponse>(
    () => apiClient.getAdminOrder({ orderId }),
    `order:${orderId}`,
  );
  const order = card.data && card.data.order.id === orderId ? card.data.order : undefined;
  const [action, setAction] = useState<Action | null>(null);
  const [minutes, setMinutes] = useState<number>(30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mark, setMark] = useState<DisciplineMark | null>(null);
  const [historyKey, setHistoryKey] = useState(0);

  const open = (next: Action) => {
    setError(null);
    setMinutes(30);
    setAction(next);
  };

  const done = (next: AdminOrder, text: string) => {
    card.replace({ order: next });
    setAction(null);
    setMark(null);
    setHistoryKey((key) => key + 1);
    toast.show(text);
  };

  const apply = async (reason: string) => {
    if (!order || !action) return;
    setBusy(true);
    setError(null);
    const params = { orderId };
    const expectedVersion = order.version;
    try {
      switch (action) {
        case "extendResponse":
        case "extendReserve":
        case "extendTerm": {
          const answer = await apiClient.extendAdminOrderDeadline(params, {
            expectedVersion,
            deadline:
              action === "extendResponse"
                ? "response"
                : action === "extendTerm"
                  ? "term"
                  : "reserve",
            minutes,
            reason,
          });
          done(answer.order, `Срок продлён на ${minutesText(minutes)}`);
          break;
        }
        case "close": {
          const answer = await apiClient.closeAdminOrder(params, { expectedVersion, reason });
          done(answer.order, "Заявка закрыта без кода");
          break;
        }
        case "cancel": {
          const answer = await apiClient.cancelAdminOrder(params, { expectedVersion, reason });
          done(answer.order, "Заявка отменена");
          break;
        }
      }
    } catch (thrown) {
      setError(orderErrorText(thrown, admins));
      // The order changed meanwhile: show it as it is now; the dialog and the reason stay.
      card.reload();
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (reason: string) => {
    if (!mark) return;
    setBusy(true);
    setError(null);
    try {
      await apiClient.revokeAdminDiscipline({ markId: mark.id }, { reason });
      setMark(null);
      card.reload();
      setHistoryKey((key) => key + 1);
      toast.show("Дисциплинарная отметка снята");
    } catch (thrown) {
      setError(orderErrorText(thrown, admins));
    } finally {
      setBusy(false);
    }
  };

  const actions = order ? orderActions(order) : null;
  const current =
    order && action === "extendResponse"
      ? order.deadlines.respondBy
      : order && action === "extendReserve"
        ? order.deadlines.reserveUntil
        : order && action === "extendTerm"
          ? order.deadlines.termAnswerBy
          : null;
  const extended = current ? new Date(new Date(current).getTime() + minutes * 60_000) : null;
  const dialog: Record<Action, { title: string; confirm: string }> = {
    extendResponse: { title: "Продлить срок ответа поставщика", confirm: "Продлить" },
    extendReserve: { title: "Продлить резерв", confirm: "Продлить" },
    extendTerm: { title: "Продлить ответ клиента", confirm: "Продлить" },
    close: { title: "Закрыть заявку без кода", confirm: "Закрыть без кода" },
    cancel: { title: "Отменить заявку", confirm: "Отменить заявку" },
  };

  return (
    <>
      <div className="page__head page__head--back">
        <IconButton icon="arrowLeft" label="Назад к заявкам" onClick={() => goBack("orders")} />
        <div className="cell-stack">
          <h1 className="ac-text-title-l page__title">
            {order ? `Заявка № ${order.number}` : "Заявка"}
          </h1>
          {order && (
            <span className="ac-text-body-s ac-muted supplier-head__line">
              <span className={`status ${statusTone(order.status)}`}>{orderStatusText(order)}</span>
              <span>
                {orderKindText(order.kind) ? `${orderKindText(order.kind)} · ` : ""}
                оформлена {formatMoment(order.createdAt)}
                {order.isTest ? " · тестовая" : ""}
              </span>
            </span>
          )}
        </div>
        <Button variant="secondary" size="s" icon="refresh" onClick={card.reload}>
          Обновить
        </Button>
      </div>
      <LoadError error={card.error} retry={card.reload} />
      <LoadingContent
        ready={order !== undefined}
        indicator={card.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={6} label="Загрузка" />}
      >
        {order && actions && (
          <div className="detail-stack">
            <div className="button-row">
              {actions.extendResponse && (
                <Button
                  variant="secondary"
                  disabled={!online}
                  onClick={() => open("extendResponse")}
                >
                  Продлить срок ответа…
                </Button>
              )}
              {actions.extendTerm && (
                <Button variant="secondary" disabled={!online} onClick={() => open("extendTerm")}>
                  Продлить ответ клиента…
                </Button>
              )}
              {actions.extendReserve && (
                <Button
                  variant="secondary"
                  disabled={!online}
                  onClick={() => open("extendReserve")}
                >
                  Продлить резерв…
                </Button>
              )}
              {actions.closeWithoutCode && (
                <Button variant="secondary" disabled={!online} onClick={() => open("close")}>
                  Закрыть без кода…
                </Button>
              )}
              {actions.cancel && (
                <Button variant="secondary" disabled={!online} onClick={() => open("cancel")}>
                  Отменить заявку…
                </Button>
              )}
            </div>
            {order.cancellation && (
              <Banner tone="neutral">
                Отменена администратором {order.cancellation.adminName ?? ""}{" "}
                {formatMoment(order.cancellation.at)}: {order.cancellation.reason}
              </Banner>
            )}
            {order.closure?.method === "admin" && (
              <Banner tone="neutral">
                Закрыта администратором без кода {formatMoment(order.closure.at)}
                {order.closure.reason ? `: ${order.closure.reason}` : ""}
              </Banner>
            )}
            {order.decline && (
              <Banner tone="neutral">
                Поставщик отказал
                {order.decline.reason ? `: ${DECLINE_REASON_TEXT[order.decline.reason]}` : ""}
                {order.decline.note ? ` («${order.decline.note}»)` : ""}
              </Banner>
            )}
            <OrderFacts order={order} />
            <Discipline
              marks={order.discipline}
              admins={admins}
              onRevoke={(next) => {
                setError(null);
                setMark(next);
              }}
            />
            <section className="card-section">
              <h2 className="ac-text-heading">Журнал заявки</h2>
              <div className="table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th scope="col">Время</th>
                      <th scope="col">Кто</th>
                      <th scope="col">Что</th>
                      <th scope="col">Причина администратора</th>
                    </tr>
                  </thead>
                  <tbody>
                    {order.events.map((event) => (
                      <tr key={event.id}>
                        <td className="ac-text-body-s num nowrap">{formatMoment(event.at)}</td>
                        <td className="ac-text-body-s">
                          {orderActorText(event.actor, admins)}
                          {channelText(event) && (
                            <span className="ac-muted"> {channelText(event)}</span>
                          )}
                        </td>
                        <td className="ac-text-body-s">{eventText(event, order.kind)}</td>
                        <td className="ac-text-body-s reason-cell">
                          {event.details.adminNote ?? <span className="ac-muted">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            <section className="card-section">
              <h2 className="ac-text-heading">Журнал действий по заявке</h2>
              <JournalHistory
                filter={{ entityType: "order", entityId: orderId }}
                loadKey={`order-history:${orderId}:${historyKey}`}
                caption="Журнал действий по заявке"
                empty="Ручных действий и раскрытий номера пока не было"
              />
            </section>
          </div>
        )}
      </LoadingContent>

      {order && action && (
        <ReasonDialog
          open
          title={dialog[action].title}
          confirm={dialog[action].confirm}
          onConfirm={apply}
          onClose={() => setAction(null)}
          busy={busy}
          error={error && <p className="dialog-error">{error}</p>}
        >
          {(action === "extendResponse" ||
            action === "extendReserve" ||
            action === "extendTerm") && (
            <>
              <label className="select">
                <span className="ac-text-caption ac-muted">На сколько продлить</span>
                <select
                  value={minutes}
                  onChange={(event) => setMinutes(Number(event.target.value))}
                >
                  {MINUTES.map((value) => (
                    <option key={value} value={value}>
                      {minutesText(value)}
                    </option>
                  ))}
                </select>
              </label>
              <WasNow
                was={`до ${formatMoment(current)}`}
                now={`до ${formatMoment(extended?.toISOString())}`}
              />
              <p className="ac-text-body-s">
                {action === "extendResponse"
                  ? "Поставщику уйдёт уведомление о заявке с новым сроком."
                  : action === "extendTerm"
                    ? "Клиент увидит новый срок ответа в приложении, поставщик — в кабинете. Уведомлений не отправляется."
                    : "Клиент увидит новый срок резерва в приложении."}
              </p>
            </>
          )}
          {action === "close" && (
            <>
              <WasNow
                was={ORDER_STATUS_TEXT[order.status]}
                now="Выдана (закрыта администратором)"
              />
              <p className="ac-text-body-s">{CLOSE_WITHOUT_CODE_TEXT}</p>
            </>
          )}
          {action === "cancel" && (
            <>
              <WasNow
                was={ORDER_STATUS_TEXT[order.status]}
                now={ORDER_STATUS_TEXT.cancelled_by_admin}
              />
              <p className="ac-text-body-s">{CANCEL_TEXT}</p>
            </>
          )}
        </ReasonDialog>
      )}
      {mark && (
        <ReasonDialog
          open
          title="Снять дисциплинарную отметку"
          confirm="Снять отметку"
          onConfirm={revoke}
          onClose={() => setMark(null)}
          busy={busy}
          error={error && <p className="dialog-error">{error}</p>}
        >
          <WasNow was="Неявка учитывается" now="Неявка снята (остаётся в истории)" />
        </ReasonDialog>
      )}
    </>
  );
}

function OrderFacts({ order }: { order: AdminOrder }) {
  return (
    <section className="card-section">
      <dl className="facts">
        <div>
          <dt>Позиция</dt>
          <dd className="long-text">
            {order.item.name.text}
            <span className="ac-text-caption ac-muted">
              {" "}
              {[order.item.brand, order.item.article].filter(Boolean).join(" · ")}
            </span>
          </dd>
        </div>
        {/* A visit for a service has no quantity (SCREENS M-ORD-01, TASK-039.B). */}
        {order.kind === "service" ? (
          <div>
            <dt>Сумма</dt>
            <dd className="num">{moneyText(order.total)}</dd>
          </div>
        ) : (
          <div>
            <dt>Количество и сумма</dt>
            <dd className="num">
              {order.quantity} шт. × {moneyText(order.unitPrice)} = {moneyText(order.total)}
            </dd>
          </div>
        )}
        <div>
          <dt>Клиент</dt>
          <dd>
            <AppLink href={userPath(order.customer.accountId)}>
              {order.customer.name ?? "Без имени"}
            </AppLink>
            <br />
            <PhoneReveal phone={order.customer.phone} subject="order" id={order.id} />
            {order.phoneRevealedAt && (
              <span className="ac-text-caption ac-muted">
                {" "}
                Поставщику номер открыт {formatMoment(order.phoneRevealedAt)}
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt>Поставщик</dt>
          <dd className="long-text">
            <AppLink href={supplierPath(order.supplier.id)}>{order.supplier.name}</AppLink>
            <span className="ac-text-caption ac-muted"> · {order.cityName}</span>
          </dd>
        </div>
        <div>
          <dt>Получение</dt>
          <dd>
            {order.kind === "service" ? "Визит в точку" : FULFILLMENT_TEXT[order.fulfillment]}
            {order.receiptOn
              ? `, дата получения ${order.receiptOn.split("-").reverse().join(".")}`
              : ""}
          </dd>
        </div>
        <div>
          <dt>Срок ответа поставщика</dt>
          <dd className="num">до {formatMoment(order.deadlines.respondBy)}</dd>
        </div>
        {orderTermLines(order).map((line) => (
          <div key={line.label}>
            <dt>{line.label}</dt>
            <dd>{line.text}</dd>
          </div>
        ))}
        {order.deadlines.reserveUntil &&
          (order.status === "accepted" ||
            order.status === "ready" ||
            order.status === "reserve_expired") && (
            <div>
              <dt>Резерв</dt>
              <dd className="num">до {formatMoment(order.deadlines.reserveUntil)}</dd>
            </div>
          )}
        {order.deadlines.lateCloseUntil && (
          <div>
            <dt>Позднее закрытие</dt>
            <dd className="num">
              поставщик может закрыть до {formatMoment(order.deadlines.lateCloseUntil)}
            </dd>
          </div>
        )}
        {order.handledBy && (
          <div>
            <dt>Обработал</dt>
            <dd>
              {orderActorText(order.handledBy)} · {formatMoment(order.handledAt)}
            </dd>
          </div>
        )}
        {order.comment && (
          <div>
            <dt>Комментарий клиента</dt>
            <dd className="long-text">{order.comment}</dd>
          </div>
        )}
      </dl>
    </section>
  );
}

const REVOKED_BY_TEXT = {
  late_close: "поставщик выдал заказ в окне позднего закрытия",
  admin_close: "заявку закрыл администратор",
  admin: "снята администратором",
} as const;

/** The discipline marks of the order, lifted ones too, with «Снять…» (A-ORD-02). */
export function Discipline({
  marks,
  admins,
  onRevoke,
  showOrder = false,
}: {
  marks: readonly DisciplineMark[];
  admins: Map<string, string | null>;
  onRevoke: (mark: DisciplineMark) => void;
  /** On a user's card: which order and supplier each mark is of. */
  showOrder?: boolean;
}) {
  if (marks.length === 0) return null;
  return (
    <section className="card-section">
      <h2 className="ac-text-heading">{showOrder ? "Неявки" : "Дисциплинарная отметка"}</h2>
      <ul className="plain-list">
        {marks.map((mark) => (
          <li key={mark.id} className="ac-text-body-s">
            Неявка {formatMoment(mark.at)}
            {showOrder && (
              <>
                {" "}
                по <AppLink href={orderPath(mark.order.id)}>
                  заявке № {mark.order.number}
                </AppLink> · {mark.supplier.name}
              </>
            )}
            {mark.revocation ? (
              <span className="ac-muted">
                {" "}
                · снята {formatMoment(mark.revocation.at)}: {REVOKED_BY_TEXT[mark.revocation.by]}
                {mark.revocation.adminId && admins.get(mark.revocation.adminId)
                  ? ` (${admins.get(mark.revocation.adminId)})`
                  : ""}
                {mark.revocation.note ? ` — «${mark.revocation.note}»` : ""}
              </span>
            ) : (
              <>
                {" "}
                <Button variant="text" size="s" onClick={() => onRevoke(mark)}>
                  Снять…
                </Button>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
