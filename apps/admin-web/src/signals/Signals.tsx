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
  Dialog,
  EmptyState,
  IconButton,
  LoadingContent,
  MenuButton,
  SkeletonList,
  StatusBadge,
  TableToolbar,
  TextAreaField,
  useToast,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useState } from "react";
import { apiClient } from "../api";
import { actionErrorText, loadErrorText } from "../errors";
import { formatMoment } from "../format";
import { FilterSelect, StatusChips } from "../layout/filters";
import { Header, RowTitle, rowLink, Table, type Column } from "../layout/layout";
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
import "./signals.css";

const PAGE = 30;

type StatusFilter = AdminSignalStatusFilter | "all";

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "current", label: "Новые и в работе" },
  { value: "open", label: "Новые" },
  { value: "acknowledged", label: "В работе" },
  { value: "closed", label: "Закрытые" },
  { value: "all", label: "Все" },
];

function kindOf(value: string | null | undefined): AdminSignalKind | undefined {
  const parsed = adminSignalKindSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function statusOf(value: string | null): StatusFilter {
  return STATUS_FILTERS.some((filter) => filter.value === value)
    ? (value as StatusFilter)
    : "current";
}

/**
 * A-SIG (SCREENS 7.1; TASK-034 requirement 3, TASK-080): the kind and the
 * status in one row (in the address), a row — the kind with its object as
 * the link (the whole row opens it), «Что делать» folded, the time in one
 * line, the status and who acted. «Взять в работу» — the one small button,
 * «Закрыть…» with its comment — in «⋯»; both go to the server with the
 * version the row shows; another administrator's earlier move comes back as
 * «уже закрыт {кем}», and the row shows the signal as it is now.
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
  const [notice, setNotice] = useState<{
    tone: "warning" | "danger";
    text: string;
    conflict: boolean;
  } | null>(null);
  const [closing, setClosing] = useState<AdminSignal | null>(null);

  const go = (next: { kind?: AdminSignalKind; status: StatusFilter }) => {
    setNotice(null);
    setEdited({});
    navigateTo(
      withQuery(routePaths.signals, {
        kind: next.kind,
        status: next.status === "current" ? null : next.status,
      }),
      { replace: true },
    );
  };

  const reload = () => {
    setNotice(null);
    setEdited({});
    list.reload();
  };

  const more = extra.key === key ? extra : { key, signals: [], next: null };
  const rows = list.data
    ? [...list.data.signals, ...more.signals].map((signal) => edited[signal.id] ?? signal)
    : [];
  const nextOffset = more.signals.length > 0 ? more.next : (list.data?.nextOffset ?? null);
  const filtered = kind !== undefined || status !== "current";
  const withActions = rows.some((signal) => signal.status !== "closed");

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
      setNotice({ tone: "danger", text: loadErrorText(thrown), conflict: false });
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
        setNotice({ tone: "warning", text: conflictText(details.data.signal), conflict: true });
        return;
      }
    }
    setNotice({ tone: "danger", text: actionErrorText(thrown), conflict: false });
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

  const columns: Column[] = [
    { key: "signal", header: "Сигнал" },
    { key: "when", header: "Когда", width: 190 },
    { key: "status", header: "Статус", width: 200 },
    ...(withActions
      ? [{ key: "actions", header: "Действия", width: 200, actions: true, hiddenHeader: true }]
      : []),
  ];

  return (
    <>
      <Header
        title="Сигналы"
        actions={<IconButton icon="refresh" label="Обновить" size={20} onClick={reload} />}
      />

      <div className="filters signal-filters">
        <FilterSelect<AdminSignalKind>
          label="Тип"
          allLabel="Все типы"
          value={kind}
          options={KIND_ORDER.map((value) => ({ value, label: KIND_TITLES[value] }))}
          onChange={(next) => go({ kind: next, status })}
        />
        <StatusChips<StatusFilter>
          label="Статус сигнала"
          value={status}
          allLabel={null}
          chips={STATUS_FILTERS}
          onChange={(next) => go({ kind, status: next ?? "current" })}
        />
      </div>

      {notice && (
        <Banner
          tone={notice.tone}
          action={
            notice.conflict ? (
              <Button variant="text" size="s" onClick={reload}>
                Обновить данные
              </Button>
            ) : undefined
          }
        >
          {notice.text}
        </Banner>
      )}
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
        <div className="list-block">
          <TableToolbar total={rows.length === 0 ? null : (list.data?.total ?? null)}>
            {filtered && (
              <Button variant="text" size="s" onClick={() => go({ status: "current" })}>
                Сбросить фильтры
              </Button>
            )}
          </TableToolbar>
          {rows.length === 0 ? (
            filtered ? (
              <EmptyState
                icon="search"
                title="Сигналов нет"
                text="По этим отборам ничего нет."
                action={
                  <Button variant="secondary" onClick={() => go({ status: "current" })}>
                    Сбросить фильтры
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon="circleCheck"
                title="Нет сигналов, ждущих внимания"
                text="Сервер сам замечает то, на что нужно посмотреть, и показывает это здесь и на главной."
              />
            )
          ) : (
            <Table label="Сигналы" columns={columns} className="signal-table">
              {rows.map((signal) => (
                <SignalRow
                  key={signal.id}
                  signal={signal}
                  withActions={withActions}
                  onAcknowledge={() => acknowledge(signal)}
                  onClose={() => {
                    setNotice(null);
                    setClosing(signal);
                  }}
                />
              ))}
            </Table>
          )}
          {nextOffset !== null && (
            <Button variant="secondary" size="s" onClick={loadMore} loading={loadingMore}>
              Показать ещё
            </Button>
          )}
        </div>
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
  withActions,
  onAcknowledge,
  onClose,
}: {
  signal: AdminSignal;
  withActions: boolean;
  onAcknowledge: () => Promise<void>;
  onClose: () => void;
}) {
  const online = useOnline();
  const subject = subjectText(signal);
  const link = subjectLink(signal);
  const actor =
    signal.status === "acknowledged"
      ? actorName(signal.acknowledgedBy)
      : signal.status === "closed"
        ? `${actorName(signal.closedBy)}, ${formatMoment(signal.closedAt)}`
        : "";
  const repeats =
    signal.times > 1
      ? `повторов: ${signal.times.toLocaleString("ru-RU")}, впервые ${formatMoment(signal.firstSeenAt)}`
      : null;
  return (
    <tr {...(link ? rowLink(link) : {})}>
      <td>
        <div className="cell-stack">
          {link ? (
            <RowTitle href={link} sub={subject || undefined}>
              {KIND_TITLES[signal.kind]}
            </RowTitle>
          ) : (
            <span className="row-title">
              <span className="ac-text-body-strong">{KIND_TITLES[signal.kind]}</span>
              {subject && <span className="row-title__sub">{subject}</span>}
            </span>
          )}
          {signal.closeComment && (
            <span className="signal-comment">Комментарий: {signal.closeComment}</span>
          )}
          {/* A click on «Что делать» folds the hint; it does not open the object. */}
          <details className="disclosure signal-hint" onClick={(event) => event.stopPropagation()}>
            <summary className="disclosure__summary">Что делать</summary>
            <p className="signal-hint__text">{KIND_HINTS[signal.kind]}</p>
          </details>
        </div>
      </td>
      <td>
        <span className="signal-line ac-text-body-s">{formatMoment(signal.lastSeenAt)}</span>
        {repeats && (
          <span className="signal-line signal-line--caption" title={repeats}>
            {repeats}
          </span>
        )}
      </td>
      <td>
        <div className="cell-stack">
          <StatusBadge kind="signal" status={signal.status}>
            {STATUS_TEXT[signal.status]}
          </StatusBadge>
          {actor && (
            <span className="signal-line signal-line--caption" title={actor}>
              {actor}
            </span>
          )}
        </div>
      </td>
      {withActions && (
        <td className="admin-table__actions">
          {signal.status !== "closed" && (
            <div className="row-actions">
              {signal.status === "open" && (
                <Button variant="secondary" size="s" disabled={!online} onClick={onAcknowledge}>
                  Взять в работу
                </Button>
              )}
              <MenuButton
                size="s"
                label="Ещё действия с сигналом"
                actions={[
                  {
                    key: "close",
                    label: "Закрыть…",
                    icon: "check",
                    disabled: !online,
                    onSelect: onClose,
                  },
                ]}
              />
            </div>
          )}
        </td>
      )}
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
          <TextAreaField
            label="Комментарий (обязательно)"
            value={comment}
            maxLength={1000}
            onChange={(value) => {
              setComment(value);
              setError(null);
            }}
            error={error ?? undefined}
          />
        </div>
      )}
    </Dialog>
  );
}
