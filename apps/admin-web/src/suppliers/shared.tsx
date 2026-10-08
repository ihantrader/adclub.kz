import type { AdminCity, SupplierStateValue, SupplierType } from "@adclub/contracts";
import { Button, Dialog, SearchField } from "@adclub/ui";
import { useEffect, useState, type ReactNode } from "react";
import { apiClient } from "../api";
import { follow } from "../catalog/shared";
import { navigateTo, routePaths, useLocation, withQuery } from "../router";
import { useSaver } from "../vehicles/shared";
import { STATE_TEXT, SUPPLIER_TYPE_TEXT, supplierErrorView } from "./supplier-words";

const TABS = [
  { key: "suppliers", label: "Поставщики", href: routePaths.suppliers },
  { key: "leads", label: "Заявки на подключение", href: routePaths.supplierLeads },
] as const;

/** The pages of «Поставщики» (A-SUP-01, A-SUP-02): real links with their own addresses. */
export function SuppliersTabs({ active }: { active: (typeof TABS)[number]["key"] | null }) {
  return (
    <nav className="page-tabs" aria-label="Поставщики">
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

/** A search box that writes `q` to the address a moment after typing stops. */
export function SearchBox({ label }: { label: string }) {
  const { query, set } = useAddressFilters();
  const q = query.get("q") ?? "";
  const [text, setText] = useState(q);
  useEffect(() => {
    const trimmed = text.trim();
    if (trimmed === q) return;
    const timer = setTimeout(() => set({ q: trimmed || undefined }), 350);
    return () => clearTimeout(timer);
  });
  return <SearchField label={label} value={text} onChange={setText} clearLabel="Очистить" />;
}

/** Saving a change of a supplier or a request with the section's words (`useSaver`). */
export function useSupplierSaver(entityType: "supplier" | "supplier_lead" | "supplier_member") {
  return useSaver(entityType, {}, supplierErrorView);
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

/** A city select: active cities, and the current one even when it is archived. */
export function CitySelect({
  label = "Город",
  value,
  onChange,
  cities,
  any,
  error,
}: {
  label?: string;
  value: string;
  onChange: (cityId: string) => void;
  cities: readonly AdminCity[];
  /** «Все» for a filter. */
  any?: string;
  error?: ReactNode;
}) {
  const shown = cities.filter((city) => city.status === "active" || city.id === value);
  return (
    <label className="select">
      <span className="ac-text-caption ac-muted">{label}</span>
      <select
        value={value}
        aria-invalid={error ? true : undefined}
        onChange={(event) => onChange(event.target.value)}
      >
        {any !== undefined ? (
          <option value="">{any}</option>
        ) : (
          !value && <option value="">—</option>
        )}
        {shown.map((city) => (
          <option key={city.id} value={city.id}>
            {city.names.ru}
            {city.status === "archived" ? " (в архиве)" : ""}
          </option>
        ))}
      </select>
      {error && <span className="ac-field__help ac-field__help--error">{error}</span>}
    </label>
  );
}

const TYPES: SupplierType[] = ["goods", "services", "both"];

export function TypeSelect({
  value,
  onChange,
  any,
}: {
  value: string;
  onChange: (type: string) => void;
  any?: string;
}) {
  return (
    <label className="select">
      <span className="ac-text-caption ac-muted">Что предлагает</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {any !== undefined && <option value="">{any}</option>}
        {TYPES.map((type) => (
          <option key={type} value={type}>
            {SUPPLIER_TYPE_TEXT[type]}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The state of a supplier as a mark: active, paused, blocked; and «проверенный». */
export function StateMark({ state, verified }: { state: SupplierStateValue; verified?: boolean }) {
  const tone =
    state === "active"
      ? "status--acknowledged"
      : state === "blocked"
        ? "status--danger"
        : "status--open";
  return (
    <span className="cell-stack">
      <span className={`status ${tone}`}>{STATE_TEXT[state]}</span>
      {verified && <span className="ac-text-caption">проверенный партнёр</span>}
    </span>
  );
}

/**
 * A dangerous action with its reason (SCREENS 7.0): what will happen, the
 * reason (required — the server refuses an empty one too), the server's
 * refusal in words.
 */
export function ReasonDialog({
  open,
  title,
  confirm,
  onConfirm,
  onClose,
  busy,
  error,
  reasonLabel = "Причина (обязательно, попадёт в журнал)",
  children,
}: {
  open: boolean;
  title: string;
  confirm: string;
  onConfirm: (reason: string) => void;
  onClose: () => void;
  busy: boolean;
  error: ReactNode;
  reasonLabel?: string;
  children?: ReactNode;
}) {
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  if (open !== shown) {
    setShown(open);
    if (open) {
      setReason("");
      setProblem(null);
    }
  }
  const submit = () => {
    const text = reason.trim();
    if (text.length < 3) {
      setProblem("Укажите причину — не короче трёх знаков");
      return;
    }
    if (text.length > 500) {
      setProblem("Причина — не длиннее 500 знаков");
      return;
    }
    onConfirm(text);
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      actions={
        <>
          <Button onClick={submit} loading={busy}>
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
        <label className="textarea">
          <span className="ac-text-caption ac-muted">{reasonLabel}</span>
          <textarea
            value={reason}
            rows={3}
            maxLength={500}
            onChange={(event) => {
              setReason(event.target.value);
              setProblem(null);
            }}
            aria-invalid={problem ? true : undefined}
          />
        </label>
        {problem && <p className="dialog-error">{problem}</p>}
        {error}
      </div>
    </Dialog>
  );
}

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
