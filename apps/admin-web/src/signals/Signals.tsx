import { isApiError } from "@adclub/api-client";
import {
  adminSignalConflictDetailsSchema,
  adminSignalKindSchema,
  type AdminSignal,
  type AdminSignalKind,
  type AdminSignalPage,
  type AdminSignalStatusFilter,
} from "@adclub/contracts";
import {
  Banner,
  Button,
  Chip,
  Dialog,
  EmptyState,
  LoadingContent,
  SkeletonList,
  useToast,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useState } from "react";
import { apiClient } from "../api";
import { AppLink } from "../catalog/shared";
import { actionErrorText, loadErrorText } from "../errors";
import { formatMoment } from "../format";
import { navigateTo, routePaths, useLocation, withQuery } from "../router";
import { reasonProblem } from "../settings/setting-rules";
import { useLoad } from "../use-load";
import {
  actorName,
  conflictText,
  KIND_HINTS,
  KIND_ORDER,
  KIND_TITLES,
  STATUS_TEXT,
  subjectLink,
  subjectText,
} from "./signal-words";

const PAGE = 30;

const STATUS_FILTERS: { value: AdminSignalStatusFilter | "all"; label: string }[] = [
  { value: "current", label: "Новые и в работе" },
  { value: "open", label: "Новые" },
  { value: "acknowledged", label: "В работе" },
  { value: "closed", label: "Закрытые" },
  { value: "all", label: "Все" },
];

function kindOf(value: string | null): AdminSignalKind | undefined {
  const parsed = adminSignalKindSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function statusOf(value: string | null): AdminSignalStatusFilter | "all" {
  return STATUS_FILTERS.some((filter) => filter.value === value)
    ? (value as AdminSignalStatusFilter | "all")
    : "current";
}

/**
 * A-SIG (SCREENS 7.1; TASK-034 requirement 3): the signals with filters by
 * kind and status (in the address), a row — kind, object, time, status and
 * who acted. «Взять в работу» and «Закрыть с комментарием» go to the server
 * with the version the row shows; another administrator's earlier move comes
 * back as «уже закрыт {кем}», and the row shows the signal as it is now.
 */
export function Signals() {
  const location = useLocation();
  const kind = kindOf(location.query.get("kind"));
  const status = statusOf(location.query.get("status"));
  const [extra, setExtra] = useState<{ key: string; signals: AdminSignal[]; next: number | null }>({
    key: "",
    signals: [],
    next: null,
  });
  const [loadingMore, setLoadingMore] = useState(false);
  const key = `${kind ?? ""}/${status}`;
  const list = useLoad<AdminSignalPage>(
    () =>
      apiClient.listAdminSignals({
        query: { kind, status: status === "all" ? undefined : status, limit: PAGE },
      }),
    key,
  );
  const [edited, setEdited] = useState<Record<string, AdminSignal>>({});
  const [notice, setNotice] = useState<{ tone: "warning" | "danger"; text: string } | null>(null);
  const [closing, setClosing] = useState<AdminSignal | null>(null);

  const go = (next: { kind?: AdminSignalKind; status: string }) => {
    setNotice(null);
    setEdited({});
    navigateTo(
      withQuery(routePaths.signals, {
        kind: next.kind,
        status: next.status === "current" ? null : next.status,
      }),
    );
  };

  const more = extra.key === key ? extra : { key, signals: [], next: null };
  const rows = list.data
    ? [...list.data.signals, ...more.signals].map((signal) => edited[signal.id] ?? signal)
    : [];
  const nextOffset = more.signals.length > 0 ? more.next : (list.data?.nextOffset ?? null);

  const loadMore = async () => {
    if (nextOffset === null) return;
    setLoadingMore(true);
    try {
      const page = await apiClient.listAdminSignals({
        query: {
          kind,
          status: status === "all" ? undefined : status,
          limit: PAGE,
          offset: nextOffset,
        },
      });
      setExtra({ key, signals: [...more.signals, ...page.signals], next: page.nextOffset });
    } catch (thrown) {
      setNotice({ tone: "danger", text: loadErrorText(thrown) });
    } finally {
      setLoadingMore(false);
    }
  };

  /** The server's answer, or the signal as it is now after a conflict. */
  const settle = (thrown: unknown): void => {
    if (isApiError(thrown) && thrown.code === "SIGNAL_CONFLICT") {
      const details = adminSignalConflictDetailsSchema.safeParse(thrown.details);
      if (details.success) {
        setEdited((now) => ({ ...now, [details.data.signal.id]: details.data.signal }));
        setNotice({ tone: "warning", text: conflictText(details.data.signal) });
        return;
      }
    }
    setNotice({ tone: "danger", text: actionErrorText(thrown) });
  };

  const acknowledge = async (signal: AdminSignal) => {
    setNotice(null);
    try {
      const answer = await apiClient.acknowledgeAdminSignal(
        { signalId: signal.id },
        { expectedVersion: signal.version },
      );
      setEdited((now) => ({ ...now, [signal.id]: answer.signal }));
    } catch (thrown) {
      settle(thrown);
    }
  };

  return (
    <>
      <div className="page__head">
        <h1 className="ac-text-title-l page__title">Сигналы</h1>
        <Button variant="secondary" size="s" icon="refresh" onClick={list.reload}>
          Обновить
        </Button>
      </div>

      <div className="filters">
        <label className="select">
          <span className="ac-text-caption ac-muted">Тип</span>
          <select
            value={kind ?? ""}
            onChange={(event) => go({ kind: kindOf(event.target.value), status })}
          >
            <option value="">Все типы</option>
            {KIND_ORDER.map((value) => (
              <option key={value} value={value}>
                {KIND_TITLES[value]}
              </option>
            ))}
          </select>
        </label>
        <div className="chips" role="group" aria-label="Статус">
          {STATUS_FILTERS.map((filter) => (
            <Chip
              key={filter.value}
              selected={filter.value === status}
              onClick={() => go({ kind, status: filter.value })}
            >
              {filter.label}
            </Chip>
          ))}
        </div>
      </div>

      {notice && <Banner tone={notice.tone}>{notice.text}</Banner>}
      {list.error !== undefined && (
        <Banner
          tone="danger"
          action={
            <Button variant="text" size="s" onClick={list.reload}>
              Повторить
            </Button>
          }
        >
          {loadErrorText(list.error)}
        </Banner>
      )}

      <LoadingContent
        ready={list.data !== undefined}
        indicator={list.indicator}
        label="Загрузка"
        swapKey={list.answerKey}
        lock
        skeleton={<SkeletonList rows={4} label="Загрузка" />}
      >
        {rows.length === 0 ? (
          <EmptyState
            icon="circleCheck"
            title={status === "current" ? "Нет сигналов, ждущих внимания" : "Сигналов нет"}
            text="Сервер сам замечает то, на что нужно посмотреть, и показывает это здесь и на главной."
          />
        ) : (
          <div className="table-wrap">
            <table className="admin-table">
              <caption className="ac-visually-hidden">Сигналы</caption>
              <thead>
                <tr>
                  <th scope="col">Тип и объект</th>
                  <th scope="col">Когда</th>
                  <th scope="col">Статус</th>
                  <th scope="col" className="admin-table__actions">
                    Действия
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((signal) => (
                  <SignalRow
                    key={signal.id}
                    signal={signal}
                    onAcknowledge={() => acknowledge(signal)}
                    onClose={() => {
                      setNotice(null);
                      setClosing(signal);
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {nextOffset !== null && (
          <Button variant="secondary" onClick={loadMore} loading={loadingMore}>
            Показать ещё
          </Button>
        )}
      </LoadingContent>

      <CloseDialog
        signal={closing}
        onCancel={() => setClosing(null)}
        onClosed={(signal) => {
          setEdited((now) => ({ ...now, [signal.id]: signal }));
          setClosing(null);
        }}
        onConflict={(thrown) => {
          setClosing(null);
          settle(thrown);
        }}
      />
    </>
  );
}

function SignalRow({
  signal,
  onAcknowledge,
  onClose,
}: {
  signal: AdminSignal;
  onAcknowledge: () => Promise<void>;
  onClose: () => void;
}) {
  const online = useOnline();
  const subject = subjectText(signal);
  const link = subjectLink(signal);
  return (
    <tr>
      <td>
        <div className="cell-stack">
          <span className="ac-text-body-strong">{KIND_TITLES[signal.kind]}</span>
          {subject && <span className="ac-text-body-s">{subject}</span>}
          {link && (
            <span className="ac-text-body-s">
              <AppLink href={link}>Открыть объект</AppLink>
            </span>
          )}
          <span className="ac-text-caption ac-muted">{KIND_HINTS[signal.kind]}</span>
          {signal.closeComment && (
            <span className="ac-text-caption">Комментарий: {signal.closeComment}</span>
          )}
        </div>
      </td>
      <td className="num">
        <div className="cell-stack">
          <span className="ac-text-body-s">{formatMoment(signal.lastSeenAt)}</span>
          {signal.times > 1 && (
            <span className="ac-text-caption ac-muted">
              впервые {formatMoment(signal.firstSeenAt)}, повторов: {signal.times}
            </span>
          )}
        </div>
      </td>
      <td>
        <div className="cell-stack">
          <span className={`status status--${signal.status}`}>{STATUS_TEXT[signal.status]}</span>
          {signal.status === "acknowledged" && (
            <span className="ac-text-caption ac-muted">{actorName(signal.acknowledgedBy)}</span>
          )}
          {signal.status === "closed" && (
            <span className="ac-text-caption ac-muted">
              {actorName(signal.closedBy)}, {formatMoment(signal.closedAt)}
            </span>
          )}
        </div>
      </td>
      <td className="admin-table__actions">
        <div className="button-row button-row--end">
          {signal.status === "open" && (
            <Button variant="secondary" size="s" disabled={!online} onClick={onAcknowledge}>
              Взять в работу
            </Button>
          )}
          {signal.status !== "closed" && (
            <Button variant="secondary" size="s" disabled={!online} onClick={onClose}>
              Закрыть…
            </Button>
          )}
        </div>
      </td>
    </tr>
  );
}

function CloseDialog({
  signal,
  onCancel,
  onClosed,
  onConflict,
}: {
  signal: AdminSignal | null;
  onCancel: () => void;
  onClosed: (signal: AdminSignal) => void;
  onConflict: (thrown: unknown) => void;
}) {
  const toast = useToast();
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [shownFor, setShownFor] = useState<string | null>(null);
  if (signal && shownFor !== signal.id) {
    setShownFor(signal.id);
    setComment("");
    setError(null);
  }

  const submit = async () => {
    if (!signal) return;
    const problem = reasonProblem(comment);
    if (problem) {
      setError(problem.replace("причину", "комментарий").replace("Причина", "Комментарий"));
      return;
    }
    try {
      const answer = await apiClient.closeAdminSignal(
        { signalId: signal.id },
        { expectedVersion: signal.version, comment: comment.trim() },
      );
      onClosed(answer.signal);
      toast.show("Сигнал закрыт");
    } catch (thrown) {
      if (isApiError(thrown) && thrown.code === "SIGNAL_CONFLICT") onConflict(thrown);
      else setError(actionErrorText(thrown));
    }
  };

  return (
    <Dialog
      open={signal !== null}
      onClose={onCancel}
      title="Закрыть сигнал"
      actions={
        <>
          <Button onClick={submit}>Закрыть сигнал</Button>
          <Button variant="secondary" onClick={onCancel}>
            Отмена
          </Button>
        </>
      }
    >
      {signal && (
        <div className="dialog-stack">
          <p>
            {KIND_TITLES[signal.kind]}
            {subjectText(signal) ? ` — ${subjectText(signal)}` : ""}. Статус станет «Закрыт»,
            комментарий попадёт в журнал действий.
          </p>
          <label className="textarea">
            <span className="ac-text-caption ac-muted">Комментарий (обязательно)</span>
            <textarea
              value={comment}
              rows={3}
              maxLength={1000}
              onChange={(event) => setComment(event.target.value)}
              aria-invalid={error ? true : undefined}
            />
          </label>
          {error && <p className="dialog-error">{error}</p>}
        </div>
      )}
    </Dialog>
  );
}
