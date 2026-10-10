import type { AdminExtendOrdersResponse, AdminExtensionCandidatesPage } from "@adclub/contracts";
import {
  Banner,
  Button,
  Checkbox,
  EmptyState,
  IconButton,
  LoadingContent,
  SkeletonList,
  useToast,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useState } from "react";
import { apiClient } from "../api";
import { AppLink } from "../catalog/shared";
import { formatMoment } from "../format";
import { goBack, navigateTo, orderExtensionsPath, orderPath, useLocation } from "../router";
import { ReasonDialog, WasNow } from "../suppliers/shared";
import { useLoad } from "../use-load";
import { LoadError } from "../vehicles/shared";
import { orderErrorText, SKIP_REASON_TEXT } from "./order-words";

const MINUTES = [15, 30, 60, 120, 240] as const;
const HOUR_MS = 3_600_000;

/** `2026-10-07T13:00` in Almaty for a `datetime-local` field, and back. */
function localOf(iso: string): string {
  const shifted = new Date(new Date(iso).getTime() + 5 * HOUR_MS);
  return shifted.toISOString().slice(0, 16);
}

function isoOf(local: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return undefined;
  return new Date(`${local}:00+05:00`).toISOString();
}

/**
 * A-ORD-03 «Массовое продление» (SCREENS 7.5; TASK-036.B): from the signal
 * of an outage («Продлить сроки» on the home page and in «Сигналы») — the
 * orders created since it began that still wait for the supplier's answer,
 * those whose notices reached nobody marked «уведомление не дошло»; the
 * administrator picks them, «Продлить на N минут» with a reason, and sees
 * what was extended and what was skipped and why. Extending the answer
 * deadline sends the notice of the order again (the queue delivers it once
 * the channel is back, ARCHITECTURE 4.36 I379).
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
      <div className="page__head page__head--back">
        <IconButton icon="arrowLeft" label="Назад" onClick={() => goBack("orders")} />
        <h1 className="ac-text-title-l page__title">Продлить сроки после сбоя</h1>
        <Button variant="secondary" size="s" icon="refresh" onClick={list.reload}>
          Обновить
        </Button>
      </div>
      <p className="ac-text-body-s ac-muted">
        Заявки, оформленные с начала сбоя и всё ещё ждущие ответа поставщика. Продление срока ответа
        заново отправляет поставщику уведомление о заявке — оно уйдёт, когда канал заработает.
      </p>
      <div className="filters">
        <label className="select">
          <span className="ac-text-caption ac-muted">Заявки с (время Алматы)</span>
          <input
            type="datetime-local"
            value={localOf(from)}
            onChange={(event) => {
              const next = isoOf(event.target.value);
              if (next) navigateTo(orderExtensionsPath(next), { replace: true });
            }}
          />
        </label>
        <label className="select">
          <span className="ac-text-caption ac-muted">Продлить на</span>
          <select value={minutes} onChange={(event) => setMinutes(Number(event.target.value))}>
            {MINUTES.map((value) => (
              <option key={value} value={value}>
                {value < 60 ? `${value} мин` : `${value / 60} ч`}
              </option>
            ))}
          </select>
        </label>
        <Button
          disabled={!online || chosen.length === 0}
          onClick={() => {
            setError(null);
            setAsking(true);
          }}
        >
          Продлить выбранные ({chosen.length})
        </Button>
      </div>
      {result && (
        <Banner tone={result.skipped.length > 0 ? "warning" : "neutral"}>
          <div className="cell-stack">
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
          </div>
        </Banner>
      )}
      <LoadError error={list.error} retry={list.reload} />
      <LoadingContent
        ready={list.data !== undefined}
        indicator={list.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={5} label="Загрузка" />}
      >
        {list.data && (
          <p className="ac-text-body-s ac-muted">
            Ждут ответа: {list.data.total}
            {list.data.truncated ? ` (показаны первые ${orders.length})` : ""} · окно{" "}
            {formatMoment(list.data.window.from)} — {formatMoment(list.data.window.to)}
          </p>
        )}
        {orders.length === 0 ? (
          <EmptyState
            icon="circleCheck"
            title="Ждущих ответа заявок нет"
            text="Все заявки этого окна уже приняты, отклонены или истекли"
          />
        ) : (
          <div className="table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th scope="col">
                    <span className="ac-visually-hidden">Выбрать</span>
                  </th>
                  <th scope="col">Номер</th>
                  <th scope="col">Поставщик</th>
                  <th scope="col">Оформлена</th>
                  <th scope="col">Срок ответа</th>
                  <th scope="col">Уведомления</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => (
                  <tr key={order.id}>
                    <td>
                      <Checkbox
                        label={`№ ${order.number}`}
                        checked={!unchecked.has(order.id)}
                        onChange={(on) => toggle(order.id, on)}
                      />
                    </td>
                    <td className="num nowrap">
                      <AppLink href={orderPath(order.id)}>№ {order.number}</AppLink>
                      {order.isTest && (
                        <span className="ac-text-caption ac-muted"> · тестовая</span>
                      )}
                    </td>
                    <td className="long-text">{order.supplier.name}</td>
                    <td className="ac-text-body-s num">{formatMoment(order.createdAt)}</td>
                    <td className="ac-text-body-s num">{formatMoment(order.respondBy)}</td>
                    <td className="ac-text-body-s">
                      {order.unnotified ? (
                        <span className="status status--danger">уведомление не дошло</span>
                      ) : (
                        <span className="ac-muted">
                          доставлено {order.notice.delivered} из {order.notice.recipients}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </LoadingContent>
      <ReasonDialog
        open={asking}
        title={`Продлить срок ответа: ${chosen.length} заявок`}
        confirm={`Продлить на ${minutes < 60 ? `${minutes} мин` : `${minutes / 60} ч`}`}
        onConfirm={extend}
        onClose={() => setAsking(false)}
        busy={busy}
        error={error && <p className="dialog-error">{error}</p>}
      >
        <WasNow
          was="срок ответа — как сейчас у каждой заявки"
          now={`срок ответа + ${minutes < 60 ? `${minutes} мин` : `${minutes / 60} ч`}`}
        />
        <p className="ac-text-body-s">
          Заявку, которую за это время приняли, отклонили или которая истекла, сервер пропустит и
          скажет почему. Поставщикам уйдут уведомления с новым сроком.
        </p>
      </ReasonDialog>
    </>
  );
}
