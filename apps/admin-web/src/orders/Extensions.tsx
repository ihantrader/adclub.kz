import type { AdminExtendOrdersResponse, AdminExtensionCandidatesPage } from "@adclub/contracts";
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  DateField,
  EmptyState,
  IconButton,
  LoadingContent,
  Select,
  SkeletonList,
  TableToolbar,
  TextField,
  TypeMark,
  useToast,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useState } from "react";
import { apiClient } from "../api";
import { formatMoment } from "../format";
import { Header, RowTitle, rowLink, Table } from "../layout/layout";
import { navigateTo, orderExtensionsPath, orderPath, useLocation } from "../router";
import { ReasonDialog, WasNow } from "../suppliers/shared";
import { useLoad } from "../use-load";
import { LoadError } from "../vehicles/shared";
import { ORDERS_CRUMB } from "./OrderCard";
import {
  almatyMoment,
  almatyParts,
  maskTime,
  orderErrorText,
  SKIP_REASON_TEXT,
  windowText,
} from "./order-words";
import "./orders.css";

const MINUTES = [15, 30, 60, 120, 240] as const;
const HOUR_MS = 3_600_000;

function minutesText(minutes: number): string {
  return minutes < 60 ? `${minutes} мин` : `${minutes / 60} ч`;
}

/**
 * A-ORD-03 «Массовое продление» (SCREENS 7.5; TASK-036.B, TASK-080): from
 * the signal of an outage («Продлить сроки» on the home page and in
 * «Сигналы») — the orders created since it began that still wait for the
 * supplier's answer, those whose notices reached nobody marked «уведомление
 * не дошло»; the beginning of the outage is a day and a time of Almaty (our
 * fields, no browser picker), the window in words («с 14:40 до 16:40
 * сегодня»). The administrator picks the orders, «Продлить на N» with a
 * reason, and sees what was extended and what was skipped and why. Nothing
 * waits — no button at all. Extending the answer deadline sends the notice
 * of the order again (the queue delivers it once the channel is back,
 * ARCHITECTURE 4.36 I379).
 */
export function Extensions() {
  const toast = useToast();
  const online = useOnline();
  const { query } = useLocation();
  const fromQuery = query.get("from");
  // Opened without a signal: the last two hours.
  const [fallback] = useState(() => new Date(Date.now() - 2 * HOUR_MS).toISOString());
  const from = fromQuery && !Number.isNaN(Date.parse(fromQuery)) ? fromQuery : fallback;
  const list = useLoad<AdminExtensionCandidatesPage>(
    () => apiClient.listAdminExtensionCandidates({ query: { from, limit: 500 } }),
    `extensions:${from}`,
  );
  const orders = list.data?.orders ?? [];
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const chosen = orders.filter((order) => !unchecked.has(order.id));
  const [minutes, setMinutes] = useState<number>(30);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AdminExtendOrdersResponse | null>(null);
  const numbers = new Map(orders.map((order) => [order.id, order.number]));

  const toggle = (orderId: string, on: boolean) =>
    setUnchecked((now) => {
      const next = new Set(now);
      if (on) next.delete(orderId);
      else next.add(orderId);
      return next;
    });

  const extend = async (reason: string) => {
    setBusy(true);
    setError(null);
    try {
      const answer = await apiClient.extendAdminOrderDeadlines({
        orders: chosen.map((order) => ({ orderId: order.id, expectedVersion: order.version })),
        minutes,
        reason,
      });
      setResult(answer);
      setAsking(false);
      setUnchecked(new Set());
      list.reload();
      toast.show(`Продлено: ${answer.extended.length}, пропущено: ${answer.skipped.length}`);
    } catch (thrown) {
      setError(orderErrorText(thrown));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Header
        crumbs={[ORDERS_CRUMB]}
        title="Продлить сроки после сбоя"
        subtitle={
          <span>
            Заявки, оформленные с начала сбоя и всё ещё ждущие ответа поставщика. Продление срока
            ответа заново отправляет поставщику уведомление о заявке — оно уйдёт, когда канал
            заработает.
          </span>
        }
        actions={<IconButton icon="refresh" label="Обновить" size={20} onClick={list.reload} />}
      />
      <OutageStart
        key={from}
        from={from}
        onChange={(next) => navigateTo(orderExtensionsPath(next), { replace: true })}
      />
      {result && (
        <Banner tone={result.skipped.length > 0 ? "warning" : "neutral"}>
          <span className="cell-stack">
            <span>
              Продлено: {result.extended.length}
              {result.extended.length > 0
                ? ` (${result.extended.map((entry) => `№ ${entry.number}`).join(", ")})`
                : ""}
            </span>
            {result.skipped.length > 0 && (
              <span>
                Пропущено: {result.skipped.length}
                <ul className="plain-list">
                  {result.skipped.map((entry) => (
                    <li key={entry.orderId}>
                      {entry.number !== null
                        ? `№ ${entry.number}`
                        : (numbers.get(entry.orderId) ?? "заявка")}
                      {" — "}
                      {SKIP_REASON_TEXT[entry.reason]}
                    </li>
                  ))}
                </ul>
              </span>
            )}
          </span>
        </Banner>
      )}
      <LoadError error={list.error} retry={list.reload} />
      <LoadingContent
        ready={list.data !== undefined}
        indicator={list.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={5} label="Загрузка" />}
      >
        <div className="list-block">
          {list.data && (
            <p className="ac-text-body-s ac-muted">
              Окно сбоя: {windowText(list.data.window.from, list.data.window.to)}
            </p>
          )}
          {orders.length === 0 ? (
            <EmptyState
              icon="circleCheck"
              title="Ждущих ответа заявок нет"
              text="Все заявки этого окна уже приняты, отклонены или истекли"
            />
          ) : (
            <>
              <TableToolbar total={list.data?.total ?? orders.length} totalLabel="Ждут ответа">
                <div className="extensions-apply">
                  <Select<string>
                    compact
                    label="Продлить на"
                    hideLabel
                    value={String(minutes)}
                    options={MINUTES.map((value) => ({
                      value: String(value),
                      label: `на ${minutesText(value)}`,
                    }))}
                    onChange={(value) => setMinutes(Number(value))}
                  />
                  <Button
                    size="s"
                    disabled={!online || chosen.length === 0}
                    onClick={() => {
                      setError(null);
                      setAsking(true);
                    }}
                  >
                    Продлить выбранные ({chosen.length})
                  </Button>
                </div>
              </TableToolbar>
              {list.data?.truncated && (
                <p className="ac-text-body-s ac-muted">Показаны первые {orders.length}</p>
              )}
              <Table
                label="Заявки, ждущие ответа"
                columns={[
                  { key: "pick", header: "Выбрать", width: 56, hiddenHeader: true },
                  { key: "number", header: "Номер", width: 132 },
                  { key: "supplier", header: "Поставщик" },
                  { key: "created", header: "Оформлена", width: 140 },
                  { key: "respond", header: "Срок ответа", width: 140 },
                  { key: "notice", header: "Уведомления", width: 220 },
                ]}
              >
                {orders.map((order) => (
                  <tr key={order.id} {...rowLink(orderPath(order.id))}>
                    <td>
                      <Checkbox
                        label={<span className="ac-visually-hidden">№ {order.number}</span>}
                        checked={!unchecked.has(order.id)}
                        onChange={(on) => toggle(order.id, on)}
                      />
                    </td>
                    <td>
                      <RowTitle
                        href={orderPath(order.id)}
                        sub={order.isTest && <TypeMark icon="info">Тест</TypeMark>}
                      >
                        <span className="nowrap">№ {order.number}</span>
                      </RowTitle>
                    </td>
                    <td className="ac-text-body-s">
                      <span className="clamp" title={order.supplier.name}>
                        {order.supplier.name}
                      </span>
                    </td>
                    <td className="ac-text-body-s nowrap">{formatMoment(order.createdAt)}</td>
                    <td className="ac-text-body-s nowrap">{formatMoment(order.respondBy)}</td>
                    <td className="ac-text-body-s">
                      {order.unnotified ? (
                        <Badge tone="danger" icon="circleX">
                          Уведомление не дошло
                        </Badge>
                      ) : (
                        <span className="ac-muted nowrap">
                          доставлено {order.notice.delivered} из {order.notice.recipients}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </Table>
            </>
          )}
        </div>
      </LoadingContent>
      <ReasonDialog
        open={asking}
        title={`Продлить срок ответа: ${chosen.length} заявок`}
        confirm={`Продлить на ${minutesText(minutes)}`}
        onConfirm={extend}
        onClose={() => setAsking(false)}
        busy={busy}
        error={error && <p className="dialog-error">{error}</p>}
      >
        <WasNow
          was="срок ответа — как сейчас у каждой заявки"
          now={`срок ответа + ${minutesText(minutes)}`}
        />
        <p className="ac-text-body-s">
          Заявку, которую за это время приняли, отклонили или которая истекла, сервер пропустит и
          скажет почему. Поставщикам уйдут уведомления с новым сроком.
        </p>
      </ReasonDialog>
    </>
  );
}

/**
 * «Начало сбоя»: a day (our date field) and a time «ЧЧ:ММ» of Almaty (X23);
 * a whole date and time moves the address, so the list follows it.
 */
function OutageStart({ from, onChange }: { from: string; onChange: (iso: string) => void }) {
  const start = almatyParts(from);
  const [date, setDate] = useState(start.date);
  const [time, setTime] = useState(start.time);
  const apply = (nextDate: string, nextTime: string) => {
    const moment = almatyMoment(nextDate, nextTime);
    if (moment && moment !== from) onChange(moment);
  };
  const timeComplete = time.length === 5;
  return (
    <fieldset className="period orders-period extensions-start">
      <legend className="ac-field__label">Начало сбоя (время Алматы)</legend>
      <div className="period__fields">
        <DateField
          compact
          label="День"
          value={date}
          locale="ru"
          onChange={(next) => {
            setDate(next);
            if (next) apply(next, time);
          }}
        />
        <TextField
          className="ac-field--compact extensions-start__time"
          label="Время"
          value={time}
          inputMode="numeric"
          placeholder="ЧЧ:ММ"
          maxLength={5}
          error={
            timeComplete && !almatyMoment(date || start.date, time)
              ? "Такого времени нет"
              : undefined
          }
          onChange={(text) => {
            const masked = maskTime(text);
            setTime(masked);
            if (masked.length === 5) apply(date, masked);
          }}
        />
      </div>
    </fieldset>
  );
}
