import {
  Badge,
  Banner,
  Button,
  Dialog,
  IconButton,
  MenuButton,
  StatusBadge,
  type MenuAction,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useEffect, useState, type ReactNode } from "react";
import { whoChanged } from "../catalog/shared";
import { loadErrorText } from "../errors";
import { FilterSearch, StatusChips } from "../layout/filters";
import { AppLink } from "../layout/layout";
import { navigateTo, routePaths, useLocation, withQuery } from "../router";
import { useLoad, type Loaded } from "../use-load";
import { conflictText, vehicleErrorView, type VehicleErrorView } from "./vehicle-words";

const TABS = [
  { key: "makes", label: "Марки и модели", href: routePaths.vehicles },
  { key: "engines", label: "Двигатели", href: routePaths.vehicleEngines },
  { key: "options", label: "Справочные списки", href: routePaths.vehicleOptions },
  { key: "imports", label: "Импорт", href: routePaths.vehicleImports },
] as const;

export type VehiclesTab = (typeof TABS)[number]["key"];

/** The pages of «Автомобили» (A-CAR-01, A-CAR-02) — the one bar of tabs of its `Header`. */
export function vehiclesTabs(active: VehiclesTab) {
  return { label: "Автомобили", items: TABS, active };
}

/**
 * The way back from a page of an object of «Автомобили» (X11: crumbs, not
 * the section's tabs): «Автомобили › Марки › Geely › Coolray». The list of
 * makes is the section's first page, so «Марки» opens it by the same path
 * with a closing slash — the crumbs are told apart by their addresses.
 */
export const VEHICLES_CRUMB = { label: "Автомобили", href: routePaths.vehicles };
export const MAKES_CRUMB = { label: "Марки", href: `${routePaths.vehicles}/` };
export const IMPORTS_CRUMB = { label: "Импорт", href: routePaths.vehicleImports };

const STATUS_CHIPS = [
  { value: "active", label: "Активные" },
  { value: "archived", label: "В архиве" },
] as const;

/** Changes values of this page's address (the filters of its list) in place. */
function setQuery(query: URLSearchParams, patch: Record<string, string | undefined>): void {
  const values: Record<string, string | undefined> = {};
  query.forEach((value, key) => {
    values[key] = value;
  });
  navigateTo(withQuery(window.location.pathname, { ...values, ...patch, highlight: undefined }), {
    replace: true,
  });
}

/** Whether the list is narrowed by the address: the search, the status, `extra` (the fuel). */
export function filteredBy(query: URLSearchParams, extra: readonly string[] = []): boolean {
  return ["q", "status", ...extra].some((key) => (query.get(key) ?? "") !== "");
}

/** «Сбросить фильтры»: this page without its query. */
export function resetFilters(): void {
  navigateTo(window.location.pathname, { replace: true });
}

/**
 * The filters of a list (X3–X5), kept in the address: one row — the search
 * (its meaning in the placeholder) and the list's own selects (`children`),
 * aligned by the bottom — and under it the status as chips.
 */
export function ListFilters({
  searchLabel,
  placeholder,
  withSearch = true,
  children,
}: {
  searchLabel: string;
  placeholder?: string;
  /** A list the server doesn't search (the modifications of a generation): the chips only. */
  withSearch?: boolean;
  children?: ReactNode;
}) {
  const location = useLocation();
  const q = location.query.get("q") ?? "";
  const asked = location.query.get("status");
  const status = asked === "active" || asked === "archived" ? asked : undefined;
  const [search, setSearch] = useState(q);
  // «Сбросить фильтры» empties the address: the field follows it.
  const [shownQ, setShownQ] = useState(q);
  if (q !== shownQ) {
    setShownQ(q);
    setSearch(q);
  }
  // The search goes to the address a moment after typing stops.
  useEffect(() => {
    if (!withSearch) return;
    const trimmed = search.trim();
    if (trimmed === q) return;
    const timer = setTimeout(() => setQuery(location.query, { q: trimmed || undefined }), 350);
    return () => clearTimeout(timer);
  });
  return (
    <div className="filters__group">
      {(withSearch || children) && (
        <div className="filters">
          {withSearch && (
            <FilterSearch
              label={searchLabel}
              placeholder={placeholder ?? searchLabel}
              value={search}
              onChange={setSearch}
              onSubmit={() => setQuery(location.query, { q: search.trim() || undefined })}
            />
          )}
          {children}
        </div>
      )}
      <StatusChips
        label="Статус"
        value={status}
        chips={STATUS_CHIPS}
        onChange={(next) => setQuery(location.query, { status: next })}
      />
    </div>
  );
}

/** A select of the filters row changes its key of the address. */
export function useFilterSetter(): (patch: Record<string, string | undefined>) => void {
  const location = useLocation();
  return (patch) => setQuery(location.query, patch);
}

/** `q` and `status` of the address, for the server. */
export function listFiltersOf(query: URLSearchParams): {
  q?: string;
  status?: "active" | "archived";
} {
  const q = query.get("q")?.trim();
  const status = query.get("status");
  return {
    ...(q ? { q } : {}),
    ...(status === "active" || status === "archived" ? { status } : {}),
  };
}

/** «В архив…» or «Восстановить…» of a record — in «⋯» of its row or of its page (X6). */
export function statusAction(
  status: "active" | "archived",
  onSelect: () => void,
  disabled: boolean,
): MenuAction {
  return status === "active"
    ? {
        key: "archive",
        label: "В архив…",
        icon: "archive",
        destructive: true,
        disabled,
        onSelect,
      }
    : { key: "restore", label: "Восстановить…", icon: "circleCheck", disabled, onSelect };
}

/**
 * The actions of a row (X6, X27): «Изменить» — one small button — and the
 * rarer archive or restore in «⋯»; never two outlined buttons in a row.
 */
export function RowActions({
  name,
  status,
  onEdit,
  onStatus,
  editDisabled,
}: {
  /** What the row is, for the screen reader name of «⋯». */
  name: string;
  status: "active" | "archived";
  onEdit: () => void;
  onStatus: () => void;
  editDisabled?: boolean;
}) {
  const online = useOnline();
  return (
    <span className="row-actions">
      <Button variant="secondary" size="s" disabled={!online || editDisabled} onClick={onEdit}>
        Изменить
      </Button>
      <MenuButton
        size="s"
        label={`Действия: ${name}`}
        actions={[statusAction(status, onStatus, !online)]}
      />
    </span>
  );
}

/**
 * The actions of the head of an object's page: «Изменить» and «⋯» with the
 * archive or restore (X11, X13: reversible, so never a red fill).
 */
export function ObjectActions({
  name,
  status,
  onEdit,
  onStatus,
  onReload,
}: {
  name: string;
  status: "active" | "archived";
  onEdit: () => void;
  onStatus: () => void;
  onReload: () => void;
}) {
  const online = useOnline();
  return (
    <>
      <RefreshButton onClick={onReload} />
      <Button variant="secondary" size="s" disabled={!online} onClick={onEdit}>
        Изменить
      </Button>
      <MenuButton label={`Действия: ${name}`} actions={[statusAction(status, onStatus, !online)]} />
    </>
  );
}

/** «Обновить» of a page head: an icon, the same on every page of the section (X11, X13). */
export function RefreshButton({ onClick }: { onClick: () => void }) {
  return <IconButton icon="refresh" label="Обновить" size={20} onClick={onClick} />;
}

export interface Page<T> {
  items: T[];
  total: number;
  nextCursor: string | null;
}

export interface Paged<T> {
  first: Loaded<Page<T>>;
  items: T[];
  total: number;
  next: string | null;
  loadMore: () => Promise<void>;
  loadingMore: boolean;
  moreError: string | null;
  /** A saved record's answer in its place, on whatever page it is. */
  update: (item: T) => void;
}

/**
 * A list the server pages by its cursor (D-069 through `useLoad`): the
 * first page, «Показать ещё», «всего N»; `key` — the filters.
 */
export function usePaged<T extends { id: string }>(
  load: (cursor?: string) => Promise<Page<T>>,
  key: string,
): Paged<T> {
  const first = useLoad<Page<T>>(() => load(), key);
  const [more, setMore] = useState<{ key: string; items: T[]; next: string | null }>({
    key: "",
    items: [],
    next: null,
  });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const extra = more.key === key && first.answerKey === key ? more : { key, items: [], next: null };
  const items = [...(first.data?.items ?? []), ...extra.items];
  const next = extra.items.length > 0 ? extra.next : (first.data?.nextCursor ?? null);
  return {
    first,
    items,
    total: first.data?.total ?? 0,
    next,
    loadingMore,
    moreError,
    loadMore: async () => {
      if (!next) return;
      setLoadingMore(true);
      setMoreError(null);
      try {
        const page = await load(next);
        setMore({ key, items: [...extra.items, ...page.items], next: page.nextCursor });
      } catch (thrown) {
        setMoreError(loadErrorText(thrown));
      } finally {
        setLoadingMore(false);
      }
    },
    update: (item) => {
      const swap = (list: T[]) => list.map((entry) => (entry.id === item.id ? item : entry));
      if (first.data) first.replace({ ...first.data, items: swap(first.data.items) });
      setMore((now) => ({ ...now, items: swap(now.items) }));
    },
  };
}

/** «Показать ещё» of a paged list and its error. */
export function MoreButton<T extends { id: string }>({ list }: { list: Paged<T> }) {
  return (
    <>
      {list.moreError && <Banner tone="danger">{list.moreError}</Banner>}
      {list.next && (
        <Button variant="secondary" size="s" onClick={list.loadMore} loading={list.loadingMore}>
          Показать ещё
        </Button>
      )}
    </>
  );
}

/**
 * Saving a change of one record (TASK-035.B): the version it is made from,
 * the server's refusal in words at its field, and a colleague's change —
 * «Эти данные только что изменил {кто}. Обновите страницу» with «Обновить
 * данные», which takes the stored version while what was typed stays (the
 * form then sends only what the administrator changed).
 */
export function useSaver(
  entityType: string,
  context: Parameters<typeof vehicleErrorView>[1] = {},
  /** What a refusal means — the vehicle catalog's words unless another section gives its own. */
  toView: (error: unknown) => VehicleErrorView = (error) => vehicleErrorView(error, context),
) {
  const [error, setError] = useState<VehicleErrorView | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  return {
    error,
    saving,
    /** The version to send: the record's, or the one «Обновить данные» took. */
    versionOf: (recordVersion: number) => version ?? recordVersion,
    reset: () => {
      setError(null);
      setVersion(null);
      setSaving(false);
    },
    /** The error at a field, with «Открыть» of a duplicate. */
    fieldError: (field: string): ReactNode =>
      error && error.field === field ? <ErrorWords error={error} /> : undefined,
    /** Takes the stored version after a conflict. */
    takeCurrent: () => {
      if (error?.currentVersion != null) setVersion(error.currentVersion);
      setError(null);
    },
    run: async (entityId: string | null, action: () => Promise<void>): Promise<boolean> => {
      setSaving(true);
      setError(null);
      try {
        await action();
        return true;
      } catch (thrown) {
        const view = toView(thrown);
        if (view.currentVersion !== null && entityId) {
          view.text = conflictText(await whoChanged(entityType, entityId));
        }
        setError(view);
        return false;
      } finally {
        setSaving(false);
      }
    },
  };
}

export type Saver = ReturnType<typeof useSaver>;

function ErrorWords({ error }: { error: VehicleErrorView }) {
  return (
    <>
      {error.text}
      {error.link && (
        <>
          {" · "}
          <AppLink href={error.link.href}>{error.link.label}</AppLink>
        </>
      )}
    </>
  );
}

/**
 * The error of a form that belongs to none of its `fields` (those show it
 * themselves), with «Открыть» or «Обновить данные».
 */
export function FormError({
  saver,
  fields = [],
  onRefresh,
}: {
  saver: Saver;
  fields?: readonly string[];
  onRefresh?: () => void;
}) {
  const error = saver.error;
  if (!error || (error.field && fields.includes(error.field))) return null;
  return (
    <div className="dialog-stack">
      <p className="dialog-error" role="alert">
        <ErrorWords error={error} />
      </p>
      {error.currentVersion !== null && (
        <Button
          variant="secondary"
          size="s"
          onClick={() => {
            saver.takeCurrent();
            onRefresh?.();
          }}
        >
          Обновить данные
        </Button>
      )}
    </div>
  );
}

/** A record's archive and restore, confirmed with what will happen (SCREENS 7.0). */
export function StatusDialog({
  open,
  title,
  confirm,
  onConfirm,
  onClose,
  error,
  busy,
  children,
}: {
  open: boolean;
  title: string;
  confirm: string;
  onConfirm: () => void;
  onClose: () => void;
  error: ReactNode;
  busy: boolean;
  children: ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      actions={
        <>
          <Button onClick={onConfirm} loading={busy}>
            {confirm}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Отмена
          </Button>
        </>
      }
    >
      <div className="dialog-stack">
        {children}
        {error}
      </div>
    </Dialog>
  );
}

interface StatusRecord {
  id: string;
  version: number;
  status: "active" | "archived";
}

/**
 * Archiving or restoring one record of a list: which one is being decided,
 * the confirmation, and the server's answer (a colleague's change, an
 * archived parent) in the dialog.
 */
export function useStatusFlow<T extends StatusRecord>(
  entityType: string,
  apply: (record: T, status: "active" | "archived", version: number) => Promise<T>,
  onDone: (record: T) => void,
  contextOf: (record: T) => Parameters<typeof vehicleErrorView>[1] = () => ({}),
) {
  const [target, setTarget] = useState<T | null>(null);
  const saver = useSaver(entityType, target ? contextOf(target) : {});
  const to = target?.status === "active" ? "archived" : "active";
  return {
    target,
    to,
    saver,
    open: (record: T) => {
      saver.reset();
      setTarget(record);
    },
    close: () => setTarget(null),
    confirm: async () => {
      if (!target) return;
      let saved: T | null = null;
      const done = await saver.run(target.id, async () => {
        saved = await apply(target, to, saver.versionOf(target.version));
      });
      if (done && saved) {
        setTarget(null);
        onDone(saved);
      }
    },
  };
}

/**
 * The status of a record (X7): a table row marks only what departs from the
 * usual — «В архиве», «Скрыта выше»; an active one has no mark there. The
 * head of an object's page names it always (`active` — the word in the
 * object's gender: «Активна», «Активно»).
 */
export function StatusMark({
  status,
  hidden,
  active,
}: {
  status: "active" | "archived";
  /** Active, but a parent above is archived: clients don't see it. */
  hidden?: boolean;
  /** Shown for an active record too (the head of a page). */
  active?: string;
}) {
  if (status === "archived") {
    return (
      <StatusBadge kind="entry" status="archived">
        В архиве
      </StatusBadge>
    );
  }
  if (hidden) {
    return (
      <Badge tone="warning" icon="alertTriangle">
        Скрыта выше
      </Badge>
    );
  }
  if (!active) return null;
  return (
    <StatusBadge kind="entry" status="active">
      {active}
    </StatusBadge>
  );
}

/**
 * The name in the first cell with its status mark beside it (X7, X20): a
 * table has no column of statuses that would stand empty in nearly every
 * row — «В архиве» or «Скрыта выше» follows the name where it applies.
 */
export function MarkedTitle({ mark, children }: { mark: ReactNode; children: ReactNode }) {
  return (
    <span className="vehicles-title">
      {children}
      {mark}
    </span>
  );
}

/** A loading error of a page with «Повторить». */
export function LoadError({ error, retry }: { error: unknown; retry: () => void }) {
  if (error === undefined) return null;
  return (
    <Banner
      tone="danger"
      action={
        <Button variant="text" size="s" onClick={retry}>
          Повторить
        </Button>
      }
    >
      {loadErrorText(error)}
    </Banner>
  );
}

/** Text of an optional number field: `null` when empty, `NaN` when not a number. */
export function numberOf(text: string): number | null {
  const trimmed = text.trim().replace(",", ".");
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : Number.NaN;
}

/** Aliases typed through commas, without empty ones and repeats. */
export function aliasesOf(text: string): string[] {
  const seen = new Set<string>();
  return text
    .split(",")
    .map((alias) => alias.trim().replace(/\s+/g, " "))
    .filter((alias) => {
      const key = alias.toLowerCase();
      if (!alias || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** Two alias lists mean the same (order and case of the list don't matter). */
export function sameAliases(a: readonly string[], b: readonly string[]): boolean {
  const sort = (list: readonly string[]) => [...list].sort().join("\n");
  return sort(a) === sort(b);
}
