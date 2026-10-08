import { Banner, Button, Dialog, SearchField } from "@adclub/ui";
import { useEffect, useState, type ReactNode } from "react";
import { whoChanged, follow } from "../catalog/shared";
import { loadErrorText } from "../errors";
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

/** The pages of «Автомобили» (A-CAR-01, A-CAR-02): real links with their own addresses. */
export function VehiclesTabs({ active }: { active: VehiclesTab }) {
  return (
    <nav className="page-tabs" aria-label="Автомобили">
      {TABS.map((tab) => (
        <a
          key={tab.key}
          href={tab.href}
          className={tab.key === active ? "page-tabs__tab page-tabs__tab--on" : "page-tabs__tab"}
          aria-current={tab.key === active ? "page" : undefined}
          onClick={(event) => follow(event, tab.href)}
        >
          {tab.label}
        </a>
      ))}
    </nav>
  );
}

/** «Марки › Geely › Coolray › I (SX11)»: every step but the last is a link. */
export function Crumbs({ steps }: { steps: { label: string; href?: string }[] }) {
  return (
    <nav aria-label="Где вы">
      <ol className="crumbs ac-text-body-s">
        {steps.map((step, index) => (
          <li key={index}>
            {step.href && index < steps.length - 1 ? (
              <a href={step.href} onClick={(event) => follow(event, step.href!)}>
                {step.label}
              </a>
            ) : (
              <span aria-current="page">{step.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** The search of a list and its status filter, kept in the address. */
export function ListFilters({
  searchLabel,
  children,
}: {
  searchLabel: string;
  children?: ReactNode;
}) {
  const location = useLocation();
  const q = location.query.get("q") ?? "";
  const status = location.query.get("status") ?? "";
  const [search, setSearch] = useState(q);
  const set = (patch: Record<string, string | undefined>) => {
    const values: Record<string, string | undefined> = {};
    location.query.forEach((value, key) => {
      values[key] = value;
    });
    navigateTo(withQuery(window.location.pathname, { ...values, ...patch, highlight: undefined }), {
      replace: true,
    });
  };
  // The search goes to the address a moment after typing stops.
  useEffect(() => {
    const trimmed = search.trim();
    if (trimmed === q) return;
    const timer = setTimeout(() => set({ q: trimmed || undefined }), 350);
    return () => clearTimeout(timer);
  });
  return (
    <div className="filters">
      <SearchField label={searchLabel} value={search} onChange={setSearch} clearLabel="Очистить" />
      <label className="select">
        <span className="ac-text-caption ac-muted">Статус</span>
        <select
          value={status}
          onChange={(event) => set({ status: event.target.value || undefined })}
        >
          <option value="">Все</option>
          <option value="active">Активные</option>
          <option value="archived">В архиве</option>
        </select>
      </label>
      {children}
    </div>
  );
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
        <Button variant="secondary" onClick={list.loadMore} loading={list.loadingMore}>
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
          <a href={error.link.href} onClick={(event) => follow(event, error.link!.href)}>
            {error.link.label}
          </a>
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

/** A status mark of a table row. */
export function StatusMark({
  status,
  hidden,
}: {
  status: "active" | "archived";
  /** Active, but a parent above is archived: clients don't see it. */
  hidden?: boolean;
}) {
  if (status === "archived") return <span className="status status--closed">В архиве</span>;
  if (hidden) return <span className="status status--acknowledged">Скрыта выше</span>;
  return <span className="status status--open">Активна</span>;
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
