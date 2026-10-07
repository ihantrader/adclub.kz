import {
  auditActorRoleSchema,
  type AuditActorRole,
  type AuditLogEntry,
  type AuditLogPage,
} from "@adclub/contracts";
import { Banner, Button, EmptyState, LoadingContent, SkeletonList } from "@adclub/ui";
import { useState, type MouseEvent } from "react";
import { apiClient } from "../api";
import { loadErrorText } from "../errors";
import { CLUB_TIME_ZONE, formatMoment } from "../format";
import { navigateTo, routePaths, useLocation, withQuery } from "../router";
import { useLoad } from "../use-load";
import {
  actionText,
  actorText,
  almatyDayStart,
  changeLines,
  entityLink,
  entityText,
  knownActions,
  knownEntities,
  ROLE_TEXT,
} from "./audit-words";

const PAGE = 50;
/** «было → стало» lines shown before «Подробнее». */
const SHORT_LINES = 2;
function roleOf(value: string | null): AuditActorRole | undefined {
  const parsed = auditActorRoleSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * A-AUD (SCREENS 7.9; TASK-034 requirement 5): the action journal with
 * filters — who acted, the kind of object, the action, the period (days of
 * Almaty) — in the address, and the next page by the server's cursor. A
 * row: the time, who (the name or the number partly hidden), the action in
 * words, the object (a link when its section exists), «было → стало»
 * compactly with «Подробнее», the reason. The server never writes order
 * codes or secrets into the journal; the page shows only what it says.
 */
export function Audit() {
  const location = useLocation();
  const query = location.query;
  const filters = {
    actorRole: roleOf(query.get("actor")),
    entityType: query.get("entity") ?? undefined,
    action: query.get("action") ?? undefined,
    from: query.get("from") ?? "",
    to: query.get("to") ?? "",
  };
  const key = JSON.stringify(filters);
  const request = (cursor?: string) =>
    apiClient.listAuditLog({
      query: {
        actorRole: filters.actorRole,
        entityType: filters.entityType || undefined,
        action: filters.action || undefined,
        from: almatyDayStart(filters.from),
        to: almatyDayStart(filters.to, 1),
        limit: PAGE,
        cursor,
      },
    });
  const first = useLoad<AuditLogPage>(() => request(), key);
  const [older, setOlder] = useState<{
    key: string;
    entries: AuditLogEntry[];
    next: string | null;
  }>({ key: "", entries: [], next: null });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const extra = older.key === key ? older : { key, entries: [], next: null };
  const entries = [...(first.data?.entries ?? []), ...extra.entries];
  const next = extra.entries.length > 0 ? extra.next : (first.data?.nextCursor ?? null);

  const set = (name: string, value: string | undefined) => {
    const values = {
      actor: filters.actorRole,
      entity: filters.entityType,
      action: filters.action,
      from: filters.from,
      to: filters.to,
      [name]: value,
    };
    navigateTo(withQuery(routePaths.audit, values), { replace: true });
  };

  const loadMore = async () => {
    if (!next) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await request(next);
      setOlder({ key, entries: [...extra.entries, ...page.entries], next: page.nextCursor });
    } catch (thrown) {
      setMoreError(loadErrorText(thrown));
    } finally {
      setLoadingMore(false);
    }
  };

  const filtered = Object.values(filters).some(Boolean);

  return (
    <>
      <div className="page__head">
        <h1 className="ac-text-title-l page__title">Журнал действий</h1>
        <Button variant="secondary" size="s" icon="refresh" onClick={first.reload}>
          Обновить
        </Button>
      </div>

      <div className="filters filters--grid">
        <label className="select">
          <span className="ac-text-caption ac-muted">Кто</span>
          <select
            value={filters.actorRole ?? ""}
            onChange={(event) => set("actor", event.target.value)}
          >
            <option value="">Все</option>
            {auditActorRoleSchema.options.map((role) => (
              <option key={role} value={role}>
                {ROLE_TEXT[role]}
              </option>
            ))}
          </select>
        </label>
        <label className="select">
          <span className="ac-text-caption ac-muted">Объект</span>
          <select
            value={filters.entityType ?? ""}
            onChange={(event) => set("entity", event.target.value)}
          >
            <option value="">Все</option>
            {knownEntities.map((entity) => (
              <option key={entity} value={entity}>
                {entityText(entity)}
              </option>
            ))}
          </select>
        </label>
        <label className="select">
          <span className="ac-text-caption ac-muted">Действие</span>
          <select
            value={filters.action ?? ""}
            onChange={(event) => set("action", event.target.value)}
          >
            <option value="">Все</option>
            {knownActions.map((action) => (
              <option key={action} value={action}>
                {actionText(action)}
              </option>
            ))}
          </select>
        </label>
        <label className="select">
          <span className="ac-text-caption ac-muted">С (время Алматы)</span>
          <input
            type="date"
            value={filters.from}
            onChange={(event) => set("from", event.target.value)}
          />
        </label>
        <label className="select">
          <span className="ac-text-caption ac-muted">По</span>
          <input
            type="date"
            value={filters.to}
            onChange={(event) => set("to", event.target.value)}
          />
        </label>
        {filtered && (
          <Button
            variant="text"
            size="s"
            onClick={() => navigateTo(routePaths.audit, { replace: true })}
          >
            Сбросить
          </Button>
        )}
      </div>

      {first.error !== undefined && (
        <Banner
          tone="danger"
          action={
            <Button variant="text" size="s" onClick={first.reload}>
              Повторить
            </Button>
          }
        >
          {loadErrorText(first.error)}
        </Banner>
      )}

      <LoadingContent
        ready={first.data !== undefined}
        indicator={first.indicator}
        label="Загрузка"
        swapKey={first.answerKey}
        skeleton={<SkeletonList rows={5} label="Загрузка" />}
      >
        {entries.length === 0 ? (
          <EmptyState
            icon="clock"
            title={filtered ? "Ничего не нашлось" : "Журнал пуст"}
            text={filtered ? "Измените отборы" : "Здесь появятся значимые действия людей"}
          />
        ) : (
          <div className="table-wrap">
            <table className="admin-table audit-table">
              <caption className="ac-visually-hidden">
                Журнал действий, время — Алматы ({CLUB_TIME_ZONE})
              </caption>
              <thead>
                <tr>
                  <th scope="col">Время</th>
                  <th scope="col">Кто</th>
                  <th scope="col">Действие и объект</th>
                  <th scope="col">Было → стало</th>
                  <th scope="col">Причина</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <Row key={entry.id} entry={entry} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {moreError && <Banner tone="danger">{moreError}</Banner>}
        {next && (
          <Button variant="secondary" onClick={loadMore} loading={loadingMore}>
            Показать ещё
          </Button>
        )}
      </LoadingContent>
    </>
  );
}

function Row({ entry }: { entry: AuditLogEntry }) {
  const [open, setOpen] = useState(false);
  const lines = changeLines(entry.before, entry.after);
  const shown = open ? lines : lines.slice(0, SHORT_LINES);
  const link = entityLink(entry.entityType, entry.entityId);
  const follow = (event: MouseEvent) => {
    if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    navigateTo(link);
  };
  return (
    <tr>
      <td className="num ac-text-body-s">{formatMoment(entry.at)}</td>
      <td>
        <div className="cell-stack">
          <span className="ac-text-body-s">{actorText(entry.actor)}</span>
          {actorText(entry.actor) !== ROLE_TEXT[entry.actor.role] && (
            <span className="ac-text-caption ac-muted">{ROLE_TEXT[entry.actor.role]}</span>
          )}
        </div>
      </td>
      <td>
        <div className="cell-stack">
          <span className="ac-text-body-strong">{actionText(entry.action)}</span>
          <span className="ac-text-caption ac-muted">
            {entityText(entry.entityType)}
            {": "}
            {link ? (
              <a href={link} onClick={follow}>
                {entry.entityId}
              </a>
            ) : (
              <span className="entity-id">{entry.entityId}</span>
            )}
          </span>
        </div>
      </td>
      <td>
        {lines.length === 0 ? (
          <span className="ac-text-caption ac-muted">—</span>
        ) : (
          <div className="cell-stack change-lines">
            {shown.map((line, index) => (
              <span key={index} className="ac-text-caption change-line">
                {line.field && <span className="ac-muted">{line.field}: </span>}
                <span className="change-line__value">{line.before}</span>
                {" → "}
                <span className="change-line__value change-line__value--new">{line.after}</span>
              </span>
            ))}
            {lines.length > SHORT_LINES && (
              <Button variant="text" size="s" onClick={() => setOpen(!open)}>
                {open ? "Свернуть" : `Подробнее (${lines.length})`}
              </Button>
            )}
          </div>
        )}
      </td>
      <td className="ac-text-body-s reason-cell">
        {entry.reason ?? <span className="ac-muted">—</span>}
      </td>
    </tr>
  );
}
