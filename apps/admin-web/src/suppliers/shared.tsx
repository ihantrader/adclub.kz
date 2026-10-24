import type { AdminCity, SupplierStateValue, SupplierType } from "@adclub/contracts";
import { Badge, Banner, Button, SearchField, Select, StatusBadge } from "@adclub/ui";
import { useEffect, useState, type ReactNode } from "react";
import { apiClient } from "../api";
import { follow } from "../layout/layout";
import { navigateTo, routePaths, useLocation, withQuery } from "../router";
import { useSaver, type Paged, type Saver } from "../vehicles/shared";
import { STATE_TEXT, SUPPLIER_TYPE_TEXT, supplierErrorView } from "./supplier-words";

type SectionTab = "suppliers" | "leads";

const TABS = [
  { key: "suppliers", label: "Поставщики", href: routePaths.suppliers },
  { key: "leads", label: "Заявки на подключение", href: routePaths.supplierLeads },
] as const;

/** The two pages of «Поставщики» (A-SUP-01, A-SUP-02) — the one bar of the section's `Header` (X11). */
export function suppliersTabs(active: SectionTab) {
  return { label: "Поставщики", items: TABS, active };
}

/** The crumbs of a page inside the section: a card, a request, a new supplier (X11). */
export const SUPPLIERS_CRUMB = { label: "Поставщики", href: routePaths.suppliers };
export const LEADS_CRUMB = { label: "Заявки на подключение", href: routePaths.supplierLeads };

/** The filters of a list, kept in the address: what is set, and a change of some of them. */
export function useAddressFilters(): {
  query: URLSearchParams;
  set: (patch: Record<string, string | undefined>) => void;
} {
  const location = useLocation();
  return {
    query: location.query,
    set: (patch) => {
      const values: Record<string, string | undefined> = {};
      location.query.forEach((value, key) => {
        values[key] = value;
      });
      navigateTo(withQuery(window.location.pathname, { ...values, ...patch }), { replace: true });
    },
  };
}

/**
 * The search of a list (X4): compact, its meaning in the placeholder, `q`
 * written to the address a moment after typing stops (Enter — at once).
 */
export function SearchBox({ label, placeholder }: { label: string; placeholder?: string }) {
  const { query, set } = useAddressFilters();
  const q = query.get("q") ?? "";
  const [text, setText] = useState(q);
  // «Сбросить фильтры» or a link changed the address: the box shows it.
  const [seen, setSeen] = useState(q);
  if (q !== seen) {
    setSeen(q);
    if (q !== text.trim()) setText(q);
  }
  useEffect(() => {
    const trimmed = text.trim();
    if (trimmed === q) return;
    const timer = setTimeout(() => set({ q: trimmed || undefined }), 350);
    return () => clearTimeout(timer);
  });
  return (
    <SearchField
      className="ac-search--compact filters__search"
      label={label}
      placeholder={placeholder ?? label}
      value={text}
      onChange={setText}
      clearLabel="Очистить поиск"
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          set({ q: text.trim() || undefined });
        }
      }}
    />
  );
}

/** Saving a change of a supplier or a request with the section's words (`useSaver`). */
export function useSupplierSaver(entityType: "supplier" | "supplier_lead" | "supplier_member") {
  return useSaver(entityType, {}, supplierErrorView);
}

/**
 * The refusal of a save that belongs to no field (those show it at
 * themselves): a banner over the form; a colleague's change —
 * «Эти данные только что изменил {кто}. Обновите страницу» with the text
 * button «Обновить данные» (SCREENS 2), which keeps what was typed.
 */
export function SaverError({
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
    <Banner
      tone="warning"
      action={
        error.currentVersion !== null ? (
          <Button
            variant="text"
            size="s"
            onClick={() => {
              saver.takeCurrent();
              onRefresh?.();
            }}
          >
            Обновить данные
          </Button>
        ) : undefined
      }
    >
      {error.text}
      {error.link && (
        <>
          {" · "}
          <a href={error.link.href} onClick={(event) => follow(event, error.link!.href)}>
            {error.link.label}
          </a>
        </>
      )}
    </Banner>
  );
}

/** «Показать ещё» of a paged list (S) and its error (X22). */
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

/** The cities of the directory for the selects — archived ones too, marked (a supplier may keep one). */
export function useCities(): AdminCity[] {
  const [cities, setCities] = useState<AdminCity[]>([]);
  useEffect(() => {
    let cancelled = false;
    apiClient.listAdminCities().then(
      (answer) => {
        if (!cancelled) setCities(answer.cities);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, []);
  return cities;
}

/** «Все» of a filter select: the value `all` stands for no filter. */
const ANY = "all";

/**
 * A city select (our `Select`, X2): active cities, and the current one even
 * when it is archived. With `any` it is a filter — compact 40 with «Все»
 * first; without — a field of a form (48) with «Выберите город».
 */
export function CitySelect({
  label = "Город",
  value,
  onChange,
  cities,
  any,
  error,
  disabled,
}: {
  label?: string;
  value: string;
  onChange: (cityId: string) => void;
  cities: readonly AdminCity[];
  /** «Все» for a filter. */
  any?: string;
  error?: ReactNode;
  disabled?: boolean;
}) {
  const shown = cities
    .filter((city) => city.status === "active" || city.id === value)
    .map((city) => ({
      value: city.id,
      label: city.status === "archived" ? `${city.names.ru} (в архиве)` : city.names.ru,
    }));
  if (any !== undefined) {
    return (
      <Select<string>
        compact
        label={label}
        value={value || ANY}
        options={[{ value: ANY, label: any }, ...shown]}
        onChange={(next) => onChange(next === ANY ? "" : next)}
        disabled={disabled}
        className="filters__select"
      />
    );
  }
  return (
    <Select<string>
      label={label}
      value={value || null}
      placeholder="Выберите город"
      options={shown}
      onChange={onChange}
      error={error}
      disabled={disabled}
    />
  );
}

const TYPES: SupplierType[] = ["goods", "services", "both"];

/** «Что предлагает»: a field of a form, or a compact filter with «Все» (`any`). */
export function TypeSelect({
  value,
  onChange,
  any,
  disabled,
}: {
  value: string;
  onChange: (type: string) => void;
  any?: string;
  disabled?: boolean;
}) {
  const options = TYPES.map((type) => ({ value: type, label: SUPPLIER_TYPE_TEXT[type] }));
  if (any !== undefined) {
    return (
      <Select<string>
        compact
        label="Что предлагает"
        value={value || ANY}
        options={[{ value: ANY, label: any }, ...options]}
        onChange={(next) => onChange(next === ANY ? "" : next)}
        disabled={disabled}
        className="filters__select"
      />
    );
  }
  return (
    <Select<string>
      label="Что предлагает"
      value={value || null}
      options={options}
      onChange={onChange}
      disabled={disabled}
    />
  );
}

/**
 * The state of a supplier (X7): its badge from the one map of statuses and
 * «Проверенный партнёр» as a mark beside it. `quiet` — a list: an active
 * company has no badge, only what departs from the usual is marked.
 */
export function StateMark({
  state,
  verified,
  quiet,
}: {
  state: SupplierStateValue;
  verified?: boolean;
  quiet?: boolean;
}) {
  return (
    <span className="badges">
      {!(quiet && state === "active") && (
        <StatusBadge kind="supplier" status={state}>
          {STATE_TEXT[state]}
        </StatusBadge>
      )}
      {verified && (
        <Badge tone="success" icon="circleCheck">
          Проверенный партнёр
        </Badge>
      )}
    </span>
  );
}

/** A decision with a required reason — one dialog for the whole admin panel (TASK-080). */
export { ReasonDialog } from "../layout/ReasonDialog";

/** «было → стало» of a state change, two lines. */
export function WasNow({ was, now }: { was: string; now: string }) {
  return (
    <div className="was-now">
      <span className="was-now__line">
        <span className="ac-text-caption ac-muted">Было:</span>
        <span className="was-now__value">{was}</span>
      </span>
      <span className="was-now__line">
        <span className="ac-text-caption ac-muted">Станет:</span>
        <span className="was-now__value was-now__value--new">{now}</span>
      </span>
    </div>
  );
}
