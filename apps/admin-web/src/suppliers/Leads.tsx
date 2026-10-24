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
  IconButton,
  LoadingContent,
  SearchField,
  SkeletonList,
  StatusBadge,
  TableToolbar,
  TextAreaField,
  TextField,
  useToast,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useEffect, useState } from "react";
import { apiClient } from "../api";
import { formatMoment } from "../format";
import { StatusChips } from "../layout/filters";
import { AppLink, Header, RowTitle, rowLink, Table } from "../layout/layout";
import { navigateTo, routePaths, supplierLeadPath, supplierPath, withQuery } from "../router";
import { count } from "../signals/signal-words";
import { LoadError, usePaged } from "../vehicles/shared";
import {
  CitySelect,
  MoreButton,
  SaverError,
  suppliersTabs,
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
  leadSearchOf,
  mobilePhone,
  PHONE_HINT,
  SUPPLIER_TYPE_TEXT,
} from "./supplier-words";
import "./suppliers.css";

type TypeFilter = NonNullable<SupplierLeadListQuery["type"]>;

const COLUMNS = [
  { key: "company", header: "Компания" },
  { key: "city", header: "Город", width: 180 },
  { key: "contact", header: "Контакт", width: 200 },
  { key: "stage", header: "Этап", width: 210 },
  { key: "at", header: "Пришла", width: 150 },
];

/**
 * A-SUP-01 «Воронка» (SCREENS 7.4; TASK-036, TASK-080): the second page of
 * «Поставщики». The stages as chips with the server's counts under the
 * other filters; one search — a part of the name, or the БИН by its digits
 * (Enter — at once); the city and the type; newest first, the whole row
 * opens the request. Requests of one БИН are marked, and so is a БИН a
 * supplier already has. The home page's «Новые заявки на подключение»
 * opens it on «Новая».
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
  const filtered = Boolean(filters.cityId || filters.type || filters.bin || filters.q);
  const list = usePaged<AdminSupplierLead>(async (cursor) => {
    const page = await apiClient.listSupplierLeads({ query: { ...filters, limit: 50, cursor } });
    // The stages' counts ride along with the first page.
    return {
      items: page.leads,
      total: page.total,
      nextCursor: page.nextCursor,
      counts: page.counts,
    };
  }, JSON.stringify(filters));
  const counts = (list.first.data as { counts?: Counts } | undefined)?.counts ?? null;
  const all = counts ? LEAD_STATUSES.reduce((sum, key) => sum + (counts[key] ?? 0), 0) : null;
  const reset = () =>
    navigateTo(withQuery(routePaths.supplierLeads, { status: filters.status }), { replace: true });

  return (
    <>
      <Header
        title="Поставщики"
        tabs={suppliersTabs("leads")}
        actions={
          <>
            <IconButton icon="refresh" label="Обновить" size={20} onClick={list.first.reload} />
            <Button size="s" icon="plus" onClick={() => setAdding(true)}>
              Добавить заявку вручную
            </Button>
          </>
        }
      />
      <div className="filters__group">
        <div className="filters">
          <LeadSearch
            q={filters.q}
            bin={filters.bin}
            onSearch={(found) => set({ q: found.q, bin: found.bin })}
          />
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
        </div>
        <StatusChips<SupplierLeadStatusValue>
          label="Этапы воронки"
          value={filters.status}
          allCount={all}
          chips={LEAD_STATUSES.map((key) => ({
            value: key,
            label: LEAD_STATUS_TEXT[key],
            count: counts ? counts[key] || null : null,
          }))}
          onChange={(next) => set({ status: next })}
        />
      </div>
      <LoadError error={list.first.error} retry={list.first.reload} />
      <LoadingContent
        ready={list.first.data !== undefined}
        indicator={list.first.indicator}
        label="Загрузка"
        swapKey={list.first.answerKey}
        skeleton={<SkeletonList rows={6} label="Загрузка" />}
      >
        <div className="list-block">
          <TableToolbar total={list.items.length === 0 ? null : list.total}>
            {filtered && (
              <Button variant="text" size="s" onClick={reset}>
                Сбросить фильтры
              </Button>
            )}
          </TableToolbar>
          {list.items.length === 0 ? (
            <EmptyState
              icon="store"
              title={filtered ? "Ничего не нашлось" : "Заявок нет"}
              text={
                filtered
                  ? "Измените поиск или отборы"
                  : filters.status
                    ? `На этапе «${LEAD_STATUS_TEXT[filters.status]}» заявок нет`
                    : "Заявки приходят с публичной формы; после звонка заявку можно добавить вручную"
              }
              action={
                filtered ? (
                  <Button variant="secondary" onClick={reset}>
                    Сбросить фильтры
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <Table label="Заявки на подключение" columns={COLUMNS}>
              {list.items.map((lead) => (
                <LeadRow key={lead.id} lead={lead} />
              ))}
            </Table>
          )}
          <MoreButton list={list} />
        </div>
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

/** The stages' counts under the other filters. */
type Counts = Partial<Record<SupplierLeadStatusValue, number>>;

/**
 * «Название или БИН» (X4): letters search the name a moment after typing
 * stops; digits are a БИН — searched when all 12 are typed, or on Enter.
 */
function LeadSearch({
  q,
  bin,
  onSearch,
}: {
  q: string | undefined;
  bin: string | undefined;
  onSearch: (found: { q?: string; bin?: string }) => void;
}) {
  const current = bin ?? q ?? "";
  const [text, setText] = useState(current);
  const [seen, setSeen] = useState(current);
  if (current !== seen) {
    setSeen(current);
    setText(current);
  }
  useEffect(() => {
    const found = leadSearchOf(text);
    if ((found.q ?? "") === (q ?? "") && (found.bin ?? "") === (bin ?? "")) return;
    // A БИН being typed waits for its twelfth digit or for Enter.
    if (found.bin !== undefined && !found.complete) return;
    const timer = setTimeout(() => onSearch({ q: found.q, bin: found.bin }), 350);
    return () => clearTimeout(timer);
  });
  return (
    <SearchField
      className="ac-search--compact filters__search"
      label="Поиск заявок"
      placeholder="Название или БИН"
      value={text}
      onChange={setText}
      clearLabel="Очистить поиск"
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        const found = leadSearchOf(text);
        onSearch({ q: found.q, bin: found.bin });
      }}
    />
  );
}

function LeadRow({ lead }: { lead: AdminSupplierLead }) {
  const href = supplierLeadPath(lead.id);
  return (
    <tr {...rowLink(href)}>
      <td>
        <span className="cell-stack">
          <RowTitle href={href} sub={`БИН ${lead.bin}`}>
            <span className="clamp" title={lead.companyName}>
              {lead.companyName}
            </span>
          </RowTitle>
          {lead.sameBinLeads > 0 && (
            <span className="row-title__sub">
              <AppLink href={withQuery(routePaths.supplierLeads, { bin: lead.bin })}>
                ещё {count(lead.sameBinLeads, "заявка", "заявки", "заявок")} этого БИН
              </AppLink>
            </span>
          )}
          {lead.existingSupplierId && lead.status !== "onboarded" && (
            <span className="row-title__sub">
              Этот БИН уже у поставщика ·{" "}
              <AppLink href={supplierPath(lead.existingSupplierId)}>Открыть</AppLink>
            </span>
          )}
        </span>
      </td>
      <td>
        <span className="cell-stack">
          <span className="ac-text-body-s cell-one-line">{lead.city.names.ru}</span>
          <span className="row-title__sub">{SUPPLIER_TYPE_TEXT[lead.type]}</span>
        </span>
      </td>
      <td>
        <span className="cell-stack">
          <span className="ac-text-body-s cell-one-line" title={lead.contactName}>
            {lead.contactName}
          </span>
          <span className="row-title__sub nowrap">{hiddenPhone(lead.phone)}</span>
        </span>
      </td>
      <td>
        <span className="cell-stack">
          <span className="badges">
            <StatusBadge kind="supplierLead" status={lead.status}>
              {LEAD_STATUS_TEXT[lead.status]}
            </StatusBadge>
          </span>
          {lead.status === "rejected" && lead.rejectReason && (
            <span className="row-title__sub cell-one-line" title={lead.rejectReason}>
              {lead.rejectReason}
            </span>
          )}
          {lead.supplierId && (
            <span className="row-title__sub">
              <AppLink href={supplierPath(lead.supplierId)}>Карточка поставщика</AppLink>
            </span>
          )}
        </span>
      </td>
      <td>
        <span className="cell-stack">
          <span className="ac-text-body-s nowrap">{formatMoment(lead.createdAt)}</span>
          <span className="row-title__sub">{LEAD_SOURCE_TEXT[lead.source]}</span>
        </span>
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
        <div className="supplier-field-pair">
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
        <TextAreaField
          label="Заметка (необязательно)"
          value={form.note}
          rows={2}
          maxLength={2000}
          onChange={(note) => change({ note })}
        />
        <SaverError
          saver={saver}
          fields={["companyName", "bin", "cityId", "contactName", "phone"]}
        />
      </div>
    </Dialog>
  );
}
