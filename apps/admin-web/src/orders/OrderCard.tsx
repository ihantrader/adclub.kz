import type { AdminOrder, AdminOrderResponse, DisciplineMark } from "@adclub/contracts";
import {
  ActionBar,
  Badge,
  Banner,
  Button,
  IconButton,
  LoadingContent,
  Segments,
  Select,
  SkeletonList,
  StatusBadge,
  TypeMark,
  useToast,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useState, type ReactNode } from "react";
import { apiClient } from "../api";
import { JournalHistory } from "../audit/JournalHistory";
import { formatMoment } from "../format";
import { AppLink, Header, RowTitle, rowLink, Table } from "../layout/layout";
import { PhoneReveal } from "../people/PhoneReveal";
import { useAdminNames } from "../people/use-admin-names";
import { orderPath, routePaths, supplierPath, userPath } from "../router";
import { ReasonDialog, WasNow } from "../suppliers/shared";
import { useLoad } from "../use-load";
import { LoadError } from "../vehicles/shared";
import { OrderMarks } from "./Orders";
import { OrderFeedback } from "./OrderFeedback";
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
  orderKindMark,
  orderStatusText,
  orderTermLines,
} from "./order-words";
import "./orders.css";

type Action = "extendResponse" | "extendReserve" | "extendTerm" | "close" | "cancel";

/** The steps an extension offers, minutes (the server caps one at `deadline_extension_max_hours`). */
const MINUTES = [15, 30, 60, 120, 240, 480, 1440] as const;

export const ORDERS_CRUMB = { label: "Заявки", href: routePaths.orders };

function minutesText(minutes: number): string {
  if (minutes < 60) return `${minutes} мин`;
  if (minutes % 1440 === 0) return `${minutes / 1440} сут`;
  return `${minutes / 60} ч`;
}

/**
 * A-ORD-02 «Карточка заявки» (SCREENS 7.5; TASK-036.B, TASK-080): the
 * crumbs of «Заявки», the number, its status and kind under it; the card
 * «Сводка» — the item, the quantity and the sum, the way it is received, the
 * deadlines on the left, the customer (the number partly hidden, «Показать
 * номер» with a trace) and the supplier on the right — and under it the
 * manual actions, each with a reason and «было → стало»: extend the answer
 * deadline or the reserve, close without a code, cancel — offered only where
 * the one table of moves allows them (none — «Действий нет: заявка
 * завершена»); the server decides again. Then the discipline mark with
 * «Снять…», the review and the complaints, the course of the order with who
 * did what (all or only the administrators) and, folded, the action journal.
 * Never the code or the QR.
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
  const kind = order ? orderKindMark(order.kind) : null;

  return (
    <>
      <Header
        crumbs={[ORDERS_CRUMB]}
        title={order ? `№ ${order.number}` : "Заявка"}
        subtitle={
          order && (
            <>
              <StatusBadge kind="order" status={order.status}>
                {orderStatusText(order)}
              </StatusBadge>
              {kind && <TypeMark icon={kind.icon}>{kind.text}</TypeMark>}
              <OrderMarks order={order} />
              <span>оформлена {formatMoment(order.createdAt)}</span>
            </>
          )
        }
        actions={<IconButton icon="refresh" label="Обновить" size={20} onClick={card.reload} />}
      />
      <LoadError error={card.error} retry={card.reload} />
      <LoadingContent
        ready={order !== undefined}
        indicator={card.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={6} label="Загрузка" />}
      >
        {order && (
          <div className="order-page">
            <Outcome order={order} />
            <section className="card" aria-labelledby="order-summary-title">
              <h2 className="card__title" id="order-summary-title">
                Сводка
              </h2>
              <OrderSummary order={order} />
              <OrderActions order={order} online={online} onOpen={open} />
            </section>
            {order.discipline.length > 0 && (
              <section className="section" aria-labelledby="order-discipline-title">
                <div className="section__head">
                  <h2 className="section__title" id="order-discipline-title">
                    Дисциплинарная отметка
                  </h2>
                </div>
                <Discipline
                  marks={order.discipline}
                  admins={admins}
                  onRevoke={(next) => {
                    setError(null);
                    setMark(next);
                  }}
                />
              </section>
            )}
            <OrderFeedback
              order={order}
              onReviewChanged={(review) => card.replace({ order: { ...order, review } })}
            />
            <OrderCourse order={order} admins={admins} historyKey={historyKey} />
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
              <Select<string>
                label="На сколько продлить"
                value={String(minutes)}
                options={MINUTES.map((value) => ({
                  value: String(value),
                  label: minutesText(value),
                }))}
                onChange={(value) => setMinutes(Number(value))}
              />
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

/** How the order ended by someone's decision: the administrator's reason, the supplier's refusal. */
function Outcome({ order }: { order: AdminOrder }) {
  return (
    <>
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
    </>
  );
}

/**
 * The manual actions of the order (requirement 6: one `ActionBar`): an
 * extension — the usual one — is the main action; closing without a code
 * and cancelling are secondary with `danger` text; none — said in words.
 */
function OrderActions({
  order,
  online,
  onOpen,
}: {
  order: AdminOrder;
  online: boolean;
  onOpen: (action: Action) => void;
}) {
  const actions = orderActions(order);
  const extend: { action: Action; label: string } | null = actions.extendResponse
    ? { action: "extendResponse", label: "Продлить срок ответа…" }
    : actions.extendTerm
      ? { action: "extendTerm", label: "Продлить ответ клиента…" }
      : actions.extendReserve
        ? { action: "extendReserve", label: "Продлить резерв…" }
        : null;
  const others = [
    actions.closeWithoutCode && (
      <Button
        key="close"
        variant="secondary"
        destructive
        disabled={!online}
        onClick={() => onOpen("close")}
      >
        Закрыть без кода…
      </Button>
    ),
    actions.cancel && (
      <Button
        key="cancel"
        variant="secondary"
        destructive
        disabled={!online}
        onClick={() => onOpen("cancel")}
      >
        Отменить заявку…
      </Button>
    ),
  ].filter(Boolean);
  if (!extend && others.length === 0) {
    return (
      <p className="ac-text-body-s ac-muted order-actions-none">Действий нет: заявка завершена</p>
    );
  }
  return (
    <ActionBar
      label="Действия с заявкой"
      main={
        extend ? (
          <Button disabled={!online} onClick={() => onOpen(extend.action)}>
            {extend.label}
          </Button>
        ) : undefined
      }
      others={others}
      note={online ? undefined : "Нужна сеть"}
    />
  );
}

function Fact({ label, children, note }: { label: string; children: ReactNode; note?: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>
        {children}
        {note && <span className="kv__note order-note">{note}</span>}
      </dd>
    </>
  );
}

/** «Сводка» in two columns: what and when on the left, who on the right (X20: one-line notes). */
function OrderSummary({ order }: { order: AdminOrder }) {
  const reserveShown =
    order.deadlines.reserveUntil &&
    (order.status === "accepted" || order.status === "ready" || order.status === "reserve_expired");
  return (
    <div className="order-summary">
      <dl className="kv">
        <Fact
          label="Позиция"
          note={[order.item.brand, order.item.article].filter(Boolean).join(" · ") || undefined}
        >
          {order.item.name.text}
        </Fact>
        {/* A visit for a service has no quantity (SCREENS M-ORD-01, TASK-039.B). */}
        {order.kind === "service" ? (
          <Fact label="Сумма">
            <span className="nowrap">{moneyText(order.total)}</span>
          </Fact>
        ) : (
          <Fact
            label="Количество и сумма"
            note={order.quantity > 1 ? `по ${moneyText(order.unitPrice)} за шт.` : undefined}
          >
            <span className="nowrap">
              {order.quantity} шт. · {moneyText(order.total)}
            </span>
          </Fact>
        )}
        <Fact
          label="Получение"
          note={
            order.receiptOn
              ? `дата получения ${order.receiptOn.split("-").reverse().join(".")}`
              : undefined
          }
        >
          {order.kind === "service" ? "Визит в точку" : FULFILLMENT_TEXT[order.fulfillment]}
        </Fact>
        <Fact label="Срок ответа поставщика">
          <span className="nowrap">до {formatMoment(order.deadlines.respondBy)}</span>
        </Fact>
        {orderTermLines(order).map((line) => (
          <Fact key={line.label} label={line.label}>
            {line.text}
          </Fact>
        ))}
        {reserveShown && (
          <Fact label="Резерв">
            <span className="nowrap">до {formatMoment(order.deadlines.reserveUntil)}</span>
          </Fact>
        )}
        {order.deadlines.lateCloseUntil && (
          <Fact label="Позднее закрытие">
            поставщик может закрыть до{" "}
            <span className="nowrap">{formatMoment(order.deadlines.lateCloseUntil)}</span>
          </Fact>
        )}
        {order.handledBy && (
          <Fact label="Обработал" note={formatMoment(order.handledAt)}>
            {orderActorText(order.handledBy)}
          </Fact>
        )}
        {order.comment && <Fact label="Комментарий клиента">{order.comment}</Fact>}
      </dl>
      <dl className="kv">
        <Fact
          label="Клиент"
          note={
            order.phoneRevealedAt
              ? `Поставщику номер открыт ${formatMoment(order.phoneRevealedAt)}`
              : undefined
          }
        >
          <span className="cell-stack">
            <AppLink href={userPath(order.customer.accountId)}>
              {order.customer.name ?? "Без имени"}
            </AppLink>
            <PhoneReveal phone={order.customer.phone} subject="order" id={order.id} />
          </span>
        </Fact>
        <Fact label="Поставщик" note={order.cityName}>
          <AppLink href={supplierPath(order.supplier.id)}>{order.supplier.name}</AppLink>
        </Fact>
      </dl>
    </div>
  );
}

type CourseFilter = "all" | "admin";

/**
 * The course of the order (A-ORD-02 «журнал с актором»): one chronology —
 * when, who («через WhatsApp»), what, the administrator's reason — with the
 * filter «Все / Только администраторы»; the action journal (manual actions
 * and revealed numbers) folded under it.
 */
function OrderCourse({
  order,
  admins,
  historyKey,
}: {
  order: AdminOrder;
  admins: Map<string, string | null>;
  historyKey: number;
}) {
  const [filter, setFilter] = useState<CourseFilter>("all");
  const events =
    filter === "admin"
      ? order.events.filter((event) => event.actor.kind === "admin")
      : order.events;
  return (
    <section className="section" aria-labelledby="order-course-title">
      <div className="section__head">
        <h2 className="section__title" id="order-course-title">
          Ход заявки
        </h2>
        <Segments<CourseFilter>
          label="Чьи действия"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "Все" },
            { value: "admin", label: "Только администраторы" },
          ]}
        />
      </div>
      {events.length === 0 ? (
        <p className="ac-text-body-s ac-muted">Администраторы с заявкой ничего не делали</p>
      ) : (
        <Table
          label="Ход заявки"
          columns={[
            { key: "at", header: "Время", width: 140 },
            { key: "who", header: "Кто", width: 220 },
            { key: "what", header: "Что" },
            { key: "reason", header: "Причина администратора", width: 260 },
          ]}
        >
          {events.map((event) => (
            <tr key={event.id}>
              <td className="ac-text-body-s nowrap">{formatMoment(event.at)}</td>
              <td className="ac-text-body-s">
                {orderActorText(event.actor, admins)}
                {channelText(event) && <span className="ac-muted"> {channelText(event)}</span>}
              </td>
              <td className="ac-text-body-s">{eventText(event, order.kind)}</td>
              <td className="ac-text-body-s">
                {event.details.adminNote ?? <span className="ac-muted">—</span>}
              </td>
            </tr>
          ))}
        </Table>
      )}
      <details className="disclosure">
        <summary className="disclosure__summary">Журнал действий по заявке</summary>
        <JournalHistory
          filter={{ entityType: "order", entityId: order.id }}
          loadKey={`order-history:${order.id}:${historyKey}`}
          caption="Журнал действий по заявке"
          empty="Ручных действий и раскрытий номера пока не было"
        />
      </details>
    </section>
  );
}

const REVOKED_BY_TEXT = {
  late_close: "поставщик выдал заказ в окне позднего закрытия",
  admin_close: "заявку закрыл администратор",
  admin: "вручную",
} as const;

/**
 * The discipline marks — of the order, or of a user with their orders
 * (`showOrder`): when, the order and its supplier, standing or lifted (how,
 * by whom, why), «Снять…» on a standing one.
 */
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
    <Table
      label={showOrder ? "Неявки" : "Дисциплинарная отметка"}
      columns={[
        ...(showOrder ? [{ key: "order", header: "Заявка", width: 120 }] : []),
        { key: "at", header: "Неявка", width: 140 },
        ...(showOrder ? [{ key: "supplier", header: "Поставщик", width: 200 }] : []),
        { key: "state", header: "Состояние" },
        { key: "actions", header: "Действия", actions: true, hiddenHeader: true, width: 120 },
      ]}
    >
      {marks.map((mark) => {
        const revokedBy =
          mark.revocation?.adminId && admins.get(mark.revocation.adminId)
            ? ` (${admins.get(mark.revocation.adminId) ?? ""})`
            : "";
        const link = showOrder ? rowLink(orderPath(mark.order.id)) : {};
        return (
          <tr key={mark.id} {...link}>
            {showOrder && (
              <td>
                <RowTitle href={orderPath(mark.order.id)}>
                  <span className="nowrap">№ {mark.order.number}</span>
                </RowTitle>
              </td>
            )}
            <td className="ac-text-body-s nowrap">{formatMoment(mark.at)}</td>
            {showOrder && (
              <td className="ac-text-body-s">
                <span className="clamp" title={mark.supplier.name}>
                  {mark.supplier.name}
                </span>
              </td>
            )}
            <td className="ac-text-body-s">
              {mark.revocation ? (
                <span className="cell-stack">
                  <span>
                    Снята {REVOKED_BY_TEXT[mark.revocation.by]}
                    {revokedBy}
                  </span>
                  <span className="ac-text-caption ac-muted">
                    {formatMoment(mark.revocation.at)}
                    {mark.revocation.note ? ` · «${mark.revocation.note}»` : ""}
                  </span>
                </span>
              ) : (
                <Badge tone="warning" icon="alertTriangle">
                  Учитывается
                </Badge>
              )}
            </td>
            <td className="admin-table__actions">
              {!mark.revocation && (
                <Button variant="secondary" size="s" onClick={() => onRevoke(mark)}>
                  Снять…
                </Button>
              )}
            </td>
          </tr>
        );
      })}
    </Table>
  );
}
