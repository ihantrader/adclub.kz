import {
  auditActorRoleSchema,
  type AuditActorRole,
  type AuditLogEntry,
  type AuditLogPage,
  type AuditLogQuery,
} from "@adclub/contracts";
import {
  Banner,
  Button,
  DateField,
  EmptyState,
  IconButton,
  LoadingContent,
  SearchSelect,
  SkeletonList,
  TableToolbar,
  type Choice,
} from "@adclub/ui";
import { useMemo, useState } from "react";
import { apiClient } from "../api";
import { loadErrorText } from "../errors";
import { FilterSelect } from "../layout/filters";
import { Header } from "../layout/layout";
import { navigateTo, routePaths, useLocation, withQuery } from "../router";
import { useLoad } from "../use-load";
import {
  actionText,
  almatyDayStart,
  entityText,
  knownActions,
  knownEntities,
  ROLE_TEXT,
} from "./audit-words";
import { JournalTable } from "./JournalTable";

const PAGE = 50;

function roleOf(value: string | null): AuditActorRole | undefined {
  const parsed = auditActorRoleSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** The kinds of objects the header's search finds, and the filter of the journal each one is. */
type ObjectKind = "order" | "user" | "member" | "supplier" | "lead" | "item";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `object=<kind>:<id>` of the address → the filter of the journal. */
export function objectFilter(value: string | null): Partial<AuditLogQuery> {
  const [kind, id] = (value ?? "").split(":");
  if (!id || !UUID.test(id)) return {};
  switch (kind as ObjectKind) {
    case "order":
      return { entityType: "order", entityId: id };
    case "user":
      return { accountId: id };
    case "member":
      return { entityType: "supplier_member", entityId: id };
    case "supplier":
      return { supplierId: id };
    case "lead":
      return { entityType: "supplier_lead", entityId: id };
    case "item":
      return { itemId: id };
    default:
      return {};
  }
}

/** The objects of the header's search as choices of «Объект». */
async function findObjects(query: string): Promise<Choice[]> {
  if (query.trim().length < 2) return [];
  const answer = await apiClient.searchAdmin({ query: { q: query.trim() } });
  return [
    ...answer.orders.map((order) => ({
      id: `order:${order.id}`,
      label: `Заявка № ${String(order.number)}`,
      note: order.supplierName,
    })),
    ...answer.users.map((user) => ({
      id: `user:${user.accountId}`,
      label: user.name ?? "Пользователь без имени",
      note: user.phone,
    })),
    ...answer.members.map((member) => ({
      id: `member:${member.memberId}`,
      label: member.displayName,
      note: `Сотрудник · ${member.supplierName}`,
    })),
    ...answer.suppliers.map((supplier) => ({
      id: `supplier:${supplier.id}`,
      label: supplier.name,
      note: "Поставщик",
    })),
    ...answer.leads.map((lead) => ({
      id: `lead:${lead.id}`,
      label: lead.companyName,
      note: "Заявка на подключение",
    })),
    ...answer.items.map((item) => ({
      id: `item:${item.id}`,
      label: item.name,
      note: [item.brand, item.article].filter(Boolean).join(" · ") || "Позиция",
    })),
  ];
}

/**
 * A-AUD (SCREENS 7.9; TASK-034, TASK-080): the action journal. One row of
 * filters — who acted, the kind of object, the action, the period (days of
 * Almaty, «с — по»), and an object found by the header's search (a number,
 * «№ 1028», a name, a БИН, an article) — in the address; the next page by
 * the server's cursor. The rows are those of every card's «История» (X16).
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
    object: query.get("object") ?? undefined,
  };
  const key = JSON.stringify(filters);
  const object = objectFilter(filters.object ?? null);
  const request = (cursor?: string) =>
    apiClient.listAuditLog({
      query: {
        actorRole: filters.actorRole,
        entityType: filters.entityType || undefined,
        action: filters.action || undefined,
        from: almatyDayStart(filters.from),
        to: almatyDayStart(filters.to, 1),
        ...object,
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
  const [objectChoice, setObjectChoice] = useState<Choice | null>(null);
  const extra = older.key === key ? older : { key, entries: [], next: null };
  const entries = [...(first.data?.entries ?? []), ...extra.entries];
  const next = extra.entries.length > 0 ? extra.next : (first.data?.nextCursor ?? null);
  const shownObject: Choice | null = !filters.object
    ? null
    : objectChoice?.id === filters.object
      ? objectChoice
      : { id: filters.object, label: entries[0]?.entityName ?? "Выбранный объект" };

  const set = (
    patch: Partial<
      Record<"actor" | "entity" | "action" | "from" | "to" | "object", string | undefined>
    >,
  ) => {
    const values = {
      actor: filters.actorRole,
      entity: filters.entityType,
      action: filters.action,
      from: filters.from,
      to: filters.to,
      object: filters.object,
      ...patch,
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
  const reset = () => {
    setObjectChoice(null);
    navigateTo(routePaths.audit, { replace: true });
  };
  const actions = useMemo(
    () => knownActions.map((action) => ({ value: action, label: actionText(action) })),
    [],
  );

  return (
    <>
      <Header
        title="Журнал"
        subtitle="Значимые действия администраторов, поставщиков, пользователей и системы; время — Алматы"
        actions={<IconButton icon="refresh" label="Обновить" size={20} onClick={first.reload} />}
      />

      <div className="filters">
        <SearchSelect
          compact
          label="Объект"
          value={shownObject}
          empty="Любой"
          placeholder="№ заявки, имя, БИН, артикул"
          search={findObjects}
          onChange={(choice) => {
            setObjectChoice(choice);
            set({ object: choice?.id });
          }}
        />
        <FilterSelect
          label="Кто"
          value={filters.actorRole}
          options={auditActorRoleSchema.options.map((role) => ({
            value: role,
            label: ROLE_TEXT[role],
          }))}
          onChange={(actor) => set({ actor })}
        />
        <FilterSelect
          label="Вид объекта"
          value={filters.entityType}
          options={knownEntities.map((entity) => ({ value: entity, label: entityText(entity) }))}
          onChange={(entity) => set({ entity })}
        />
        <FilterSelect
          label="Действие"
          value={filters.action}
          options={actions}
          onChange={(action) => set({ action })}
        />
        <fieldset className="period">
          <legend className="ac-field__label">Период</legend>
          <div className="period__fields">
            <DateField
              compact
              label="с"
              value={filters.from}
              locale="ru"
              max={filters.to || undefined}
              onChange={(from) => set({ from: from || undefined })}
            />
            <span className="period__dash" aria-hidden="true">
              —
            </span>
            <DateField
              compact
              label="по"
              value={filters.to}
              locale="ru"
              min={filters.from || undefined}
              onChange={(to) => set({ to: to || undefined })}
            />
          </div>
        </fieldset>
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
        <div className="list-block">
          <TableToolbar total={null}>
            {filtered && (
              <Button variant="text" size="s" onClick={reset}>
                Сбросить фильтры
              </Button>
            )}
          </TableToolbar>
          {entries.length === 0 ? (
            <EmptyState
              icon="history"
              title={filtered ? "Ничего не нашлось" : "Журнал пуст"}
              text={filtered ? "Измените отборы" : "Здесь появятся значимые действия людей"}
              action={
                filtered ? (
                  <Button variant="secondary" onClick={reset}>
                    Сбросить фильтры
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <JournalTable entries={entries} caption="Журнал действий" />
          )}
          {moreError && <Banner tone="danger">{moreError}</Banner>}
          {next && (
            <Button variant="secondary" size="s" onClick={loadMore} loading={loadingMore}>
              Показать ещё
            </Button>
          )}
        </div>
      </LoadingContent>
    </>
  );
}
