import type {
  AdminSupplierLead,
  SupplierLeadListQuery,
  SupplierLeadStatusValue,
  SupplierType,
} from "@adclub/contracts";
import {
  Button,
  Dialog,
  EmptyState,
  LoadingContent,
  SkeletonList,
  TextField,
  useToast,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useState } from "react";
import { apiClient } from "../api";
import { AppLink } from "../catalog/shared";
import { formatMoment } from "../format";
import { navigateTo, routePaths, supplierLeadPath, supplierPath, withQuery } from "../router";
import { count } from "../signals/signal-words";
import { FormError, LoadError, MoreButton, usePaged } from "../vehicles/shared";
import {
  CitySelect,
  SearchBox,
  SuppliersTabs,
  TypeSelect,
  useAddressFilters,
  useCities,
  useSupplierSaver,
} from "./shared";
import {
  binProblem,
  hiddenPhone,
  LEAD_SOURCE_TEXT,
  LEAD_STATUS_TEXT,
  LEAD_STATUSES,
  mobilePhone,
  PHONE_HINT,
  SUPPLIER_TYPE_TEXT,
} from "./supplier-words";

type TypeFilter = NonNullable<SupplierLeadListQuery["type"]>;

/**
 * A-SUP-01 «Воронка» (SCREENS 7.4; TASK-036): the requests by status — a
 * tab per column with the server's count under the other filters (city,
 * type, БИН, name), newest first; requests of one БИН are marked, and so
 * is a БИН a supplier already has. The home page's «Новые заявки на
 * подключение» opens it on «Новая».
 */
export function Leads() {
  const { query, set } = useAddressFilters();
  const cities = useCities();
  const [adding, setAdding] = useState(false);
  const status = (query.get("status") || undefined) as SupplierLeadStatusValue | undefined;
  const filters = {
    status: status && LEAD_STATUSES.includes(status) ? status : undefined,
    cityId: query.get("cityId") || undefined,
    type: (query.get("type") || undefined) as TypeFilter | undefined,
    bin: query.get("bin")?.trim() || undefined,
    q: query.get("q")?.trim() || undefined,
  };
  const [binText, setBinText] = useState(filters.bin ?? "");
  const list = usePaged<AdminSupplierLead>(async (cursor) => {
    const page = await apiClient.listSupplierLeads({ query: { ...filters, limit: 50, cursor } });
    // The columns' counts ride along with the first page.
    return {
      items: page.leads,
      total: page.total,
      nextCursor: page.nextCursor,
      counts: page.counts,
    };
  }, JSON.stringify(filters));
  const counts = (list.first.data as { counts?: Counts } | undefined)?.counts ?? null;
  const all = counts ? LEAD_STATUSES.reduce((sum, key) => sum + (counts[key] ?? 0), 0) : null;

  return (
    <>
      <div className="page__head">
        <h1 className="ac-text-title-l page__title">Заявки на подключение</h1>
        <Button icon="plus" onClick={() => setAdding(true)}>
          Добавить заявку вручную
        </Button>
      </div>
      <SuppliersTabs active="leads" />
      <nav className="chips funnel-tabs" aria-label="Этапы воронки">
        <FunnelTab
          label="Все"
          count={all}
          on={!filters.status}
          onClick={() => set({ status: undefined })}
        />
        {LEAD_STATUSES.map((key) => (
          <FunnelTab
            key={key}
            label={LEAD_STATUS_TEXT[key]}
            count={counts ? (counts[key] ?? 0) : null}
            on={filters.status === key}
            onClick={() => set({ status: key })}
          />
        ))}
      </nav>
      <div className="filters">
        <SearchBox label="Название компании" />
        <CitySelect
          value={filters.cityId ?? ""}
          onChange={(cityId) => set({ cityId: cityId || undefined })}
          cities={cities}
          any="Все"
        />
        <TypeSelect
          value={filters.type ?? ""}
          onChange={(type) => set({ type: type || undefined })}
          any="Все"
        />
        <form
          className="select"
          onSubmit={(event) => {
            event.preventDefault();
            set({ bin: binText.trim() || undefined });
          }}
        >
          <span className="ac-text-caption ac-muted">БИН (Enter — найти)</span>
          <input
            value={binText}
            inputMode="numeric"
            maxLength={32}
            onChange={(event) => setBinText(event.target.value)}
            onBlur={() => set({ bin: binText.trim() || undefined })}
          />
        </form>
      </div>
      <LoadError error={list.first.error} retry={list.first.reload} />
      <LoadingContent
        ready={list.first.data !== undefined}
        indicator={list.first.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={6} label="Загрузка" />}
      >
        <p className="ac-text-body-s ac-muted">Всего: {list.total.toLocaleString("ru-RU")}</p>
        {list.items.length === 0 ? (
          <EmptyState
            icon="store"
            title="Заявок нет"
            text={
              filters.status
                ? `На этапе «${LEAD_STATUS_TEXT[filters.status]}» заявок с такими отборами нет.`
                : "Заявки приходят с публичной формы; после звонка заявку можно добавить вручную."
            }
          />
        ) : (
          <div className="table-wrap">
            <table className="admin-table leads-table">
              <thead>
                <tr>
                  <th scope="col">Компания</th>
                  <th scope="col">Город и что предлагает</th>
                  <th scope="col">Контакт</th>
                  <th scope="col">Этап</th>
                  <th scope="col">Пришла</th>
                </tr>
              </thead>
              <tbody>
                {list.items.map((lead) => (
                  <LeadRow key={lead.id} lead={lead} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <MoreButton list={list} />
      </LoadingContent>
      <CreateLeadDialog
        open={adding}
        onClose={() => setAdding(false)}
        onCreated={(leadId) => {
          setAdding(false);
          navigateTo(supplierLeadPath(leadId));
        }}
      />
    </>
  );
}

/** The columns of the funnel under the other filters. */
type Counts = Partial<Record<SupplierLeadStatusValue, number>>;

function FunnelTab({
  label,
  count,
  on,
  onClick,
}: {
  label: string;
  count: number | null;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={on ? "funnel-tab funnel-tab--on" : "funnel-tab"}
      aria-pressed={on}
      onClick={onClick}
    >
      {label}
      {count !== null && <span className="funnel-tab__count">{count}</span>}
    </button>
  );
}

function LeadRow({ lead }: { lead: AdminSupplierLead }) {
  return (
    <tr>
      <td>
        <div className="cell-stack">
          <span className="long-text" title={lead.companyName}>
            <AppLink href={supplierLeadPath(lead.id)}>{lead.companyName}</AppLink>
          </span>
          <span className="ac-text-caption ac-muted mono">БИН {lead.bin}</span>
          {lead.sameBinLeads > 0 && (
            <span className="ac-text-caption">
              <AppLink href={withQuery(routePaths.supplierLeads, { bin: lead.bin })}>
                ещё {count(lead.sameBinLeads, "заявка", "заявки", "заявок")} этого БИН
              </AppLink>
            </span>
          )}
          {lead.existingSupplierId && lead.status !== "onboarded" && (
            <span className="ac-text-caption warning-text">
              Этот БИН уже у поставщика ·{" "}
              <AppLink href={supplierPath(lead.existingSupplierId)}>Открыть</AppLink>
            </span>
          )}
        </div>
      </td>
      <td>
        <div className="cell-stack">
          <span>{lead.city.names.ru}</span>
          <span className="ac-text-caption ac-muted">{SUPPLIER_TYPE_TEXT[lead.type]}</span>
        </div>
      </td>
      <td>
        <div className="cell-stack">
          <span className="long-text">{lead.contactName}</span>
          <span className="ac-text-caption ac-muted num">{hiddenPhone(lead.phone)}</span>
        </div>
      </td>
      <td>
        <div className="cell-stack">
          <span>{LEAD_STATUS_TEXT[lead.status]}</span>
          {lead.status === "rejected" && lead.rejectReason && (
            <span className="ac-text-caption ac-muted clamp" title={lead.rejectReason}>
              {lead.rejectReason}
            </span>
          )}
          {lead.supplierId && (
            <span className="ac-text-caption">
              <AppLink href={supplierPath(lead.supplierId)}>Карточка поставщика</AppLink>
            </span>
          )}
        </div>
      </td>
      <td className="num">
        <div className="cell-stack">
          <span className="ac-text-body-s">{formatMoment(lead.createdAt)}</span>
          <span className="ac-text-caption ac-muted">{LEAD_SOURCE_TEXT[lead.source]}</span>
        </div>
      </td>
    </tr>
  );
}

/** «Добавить заявку вручную» — after a call (source `admin`, status «Новая»). */
function CreateLeadDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (leadId: string) => void;
}) {
  const toast = useToast();
  const online = useOnline();
  const cities = useCities();
  const saver = useSupplierSaver("supplier_lead");
  const empty = {
    companyName: "",
    bin: "",
    cityId: "",
    type: "goods" as SupplierType,
    contactName: "",
    phone: "+7",
    note: "",
  };
  const [form, setForm] = useState(empty);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [shown, setShown] = useState(false);
  if (open !== shown) {
    setShown(open);
    if (open) {
      setForm(empty);
      setProblems({});
      saver.reset();
    }
  }
  const change = (patch: Partial<typeof form>) => {
    setForm((now) => ({ ...now, ...patch }));
    setProblems({});
  };

  const submit = async () => {
    const found: Record<string, string> = {};
    if (!form.companyName.trim()) found.companyName = "Укажите название компании";
    const bin = binProblem(form.bin);
    if (bin) found.bin = bin;
    if (!form.cityId) found.cityId = "Выберите город";
    if (!form.contactName.trim()) found.contactName = "Укажите контактное лицо";
    const phone = mobilePhone(form.phone);
    if (!phone) found.phone = PHONE_HINT;
    setProblems(found);
    if (Object.keys(found).length > 0 || !phone) return;
    let leadId: string | null = null;
    await saver.run(null, async () => {
      const answer = await apiClient.createSupplierLead({
        companyName: form.companyName.trim(),
        bin: form.bin.trim(),
        cityId: form.cityId,
        type: form.type,
        contactName: form.contactName.trim(),
        phone,
        ...(form.note.trim() ? { note: form.note.trim() } : {}),
      });
      leadId = answer.lead.lead.id;
    });
    if (leadId) {
      toast.show("Заявка добавлена");
      onCreated(leadId);
    }
  };

  const fieldError = (field: string) => problems[field] ?? saver.fieldError(field);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Добавить заявку вручную"
      actions={
        <>
          <Button onClick={submit} loading={saver.saving} disabled={!online}>
            Добавить
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Отмена
          </Button>
        </>
      }
    >
      <div className="dialog-stack">
        <p className="ac-text-body-s ac-muted">
          Заявка появится на этапе «Новая» с пометкой «добавлена вручную».
        </p>
        <TextField
          label="Компания"
          value={form.companyName}
          onChange={(companyName) => change({ companyName })}
          maxLength={200}
          error={fieldError("companyName")}
        />
        <TextField
          label="БИН"
          value={form.bin}
          onChange={(bin) => change({ bin })}
          inputMode="numeric"
          maxLength={32}
          error={fieldError("bin")}
        />
        <div className="field-row">
          <CitySelect
            value={form.cityId}
            onChange={(cityId) => change({ cityId })}
            cities={cities}
            error={fieldError("cityId")}
          />
          <TypeSelect
            value={form.type}
            onChange={(type) => change({ type: type as SupplierType })}
          />
        </div>
        <TextField
          label="Контактное лицо"
          value={form.contactName}
          onChange={(contactName) => change({ contactName })}
          maxLength={100}
          error={fieldError("contactName")}
        />
        <TextField
          label="Телефон"
          value={form.phone}
          onChange={(phone) => change({ phone })}
          type="tel"
          inputMode="tel"
          error={fieldError("phone")}
        />
        <label className="textarea">
          <span className="ac-text-caption ac-muted">Заметка (необязательно)</span>
          <textarea
            value={form.note}
            rows={2}
            maxLength={2000}
            onChange={(event) => change({ note: event.target.value })}
          />
        </label>
        <FormError
          saver={saver}
          fields={["companyName", "bin", "cityId", "contactName", "phone"]}
        />
      </div>
    </Dialog>
  );
}
