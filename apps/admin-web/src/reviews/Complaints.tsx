import {
  complaintReasonSchema,
  type AdminComplaint,
  type AdminComplaintListQuery,
  type AdminComplaintPage,
  type AdminComplaintResponse,
  type ComplaintReasonValue,
} from "@adclub/contracts";
import {
  Banner,
  Button,
  Chip,
  EmptyState,
  IconButton,
  LoadingContent,
  SkeletonList,
  useToast,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useState } from "react";
import { apiClient } from "../api";
import { JournalHistory } from "../audit/JournalHistory";
import { AppLink } from "../catalog/shared";
import { formatMoment } from "../format";
import { useSupplierChoice } from "../orders/Orders";
import { PhoneReveal } from "../people/PhoneReveal";
import { complaintPath, goBack, orderPath, supplierPath, userPath } from "../router";
import { SearchSelect } from "../search-select/SearchSelect";
import { createChoiceSources } from "../search-select/sources";
import { ReasonDialog, WasNow, useAddressFilters } from "../suppliers/shared";
import { useLoad } from "../use-load";
import { LoadError, MoreButton, usePaged } from "../vehicles/shared";
import { ReviewSectionTabs } from "./Reviews";
import {
  COMPLAINT_REASON_TEXT,
  COMPLAINT_STATUS_FILTERS,
  COMPLAINT_STATUS_TEXT,
  complaintErrorText,
  complaintTone,
} from "./review-words";

const supplierSearch = createChoiceSources(apiClient).suppliers();

type StatusFilter = (typeof COMPLAINT_STATUS_FILTERS)[number]["value"];

function statusOf(value: string | null): StatusFilter {
  return COMPLAINT_STATUS_FILTERS.some((filter) => filter.value === value)
    ? (value as StatusFilter)
    : "open";
}

function reasonOf(value: string | null): ComplaintReasonValue | undefined {
  const parsed = complaintReasonSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** A list of complaints by the filters given (offset pages). */
export function useComplaintList(filter: Omit<AdminComplaintListQuery, "limit" | "offset">) {
  return usePaged<AdminComplaint>(async (cursor) => {
    const page: AdminComplaintPage = await apiClient.listAdminComplaints({
      query: { ...filter, limit: 30, offset: cursor ? Number(cursor) : 0 },
    });
    return {
      items: page.complaints,
      total: page.total,
      nextCursor: page.nextOffset === null ? null : String(page.nextOffset),
    };
  }, JSON.stringify(filter));
}

/**
 * A-REV-02 «Жалобы» (SCREENS 7.7; TASK-049): the status (new and in work by
 * default), the reason and the supplier in the address; a row — the reason,
 * the order, the user, the supplier, the status — opens the card.
 */
export function Complaints() {
  const { query, set } = useAddressFilters();
  const status = statusOf(query.get("status"));
  const reason = reasonOf(query.get("reason"));
  const supplierId = query.get("supplierId") ?? undefined;
  const list = useComplaintList({
    status: status === "all" ? undefined : status,
    reason,
    supplierId,
  });
  const supplier = useSupplierChoice(supplierId ?? null, list.items);

  return (
    <>
      <div className="page__head">
        <h1 className="ac-text-title-l page__title">Отзывы и жалобы</h1>
      </div>
      <ReviewSectionTabs active="complaints" />
      <div className="filters">
        <div className="chips" role="group" aria-label="Статус">
          {COMPLAINT_STATUS_FILTERS.map((filter) => (
            <Chip
              key={filter.value}
              selected={filter.value === status}
              onClick={() => set({ status: filter.value === "open" ? undefined : filter.value })}
            >
              {filter.label}
            </Chip>
          ))}
        </div>
      </div>
      <div className="filters filters--grid">
        <label className="select">
          <span className="ac-text-caption ac-muted">Причина</span>
          <select
            value={reason ?? ""}
            onChange={(event) => set({ reason: event.target.value || undefined })}
          >
            <option value="">Все</option>
            {complaintReasonSchema.options.map((value) => (
              <option key={value} value={value}>
                {COMPLAINT_REASON_TEXT[value]}
              </option>
            ))}
          </select>
        </label>
        <div className="filters__select-search">
          <SearchSelect
            label="Поставщик"
            value={supplier.value}
            onChange={(choice) => {
              supplier.remember(choice);
              set({ supplierId: choice?.id });
            }}
            search={supplierSearch}
            empty="Все"
          />
        </div>
      </div>
      <LoadError error={list.first.error} retry={list.first.reload} />
      <LoadingContent
        ready={list.first.data !== undefined}
        indicator={list.first.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={5} label="Загрузка" />}
      >
        <p className="ac-text-body-s ac-muted">Всего: {list.total.toLocaleString("ru-RU")}</p>
        {list.items.length === 0 ? (
          <EmptyState icon="circleCheck" title="Жалоб нет" text="Измените отборы" />
        ) : (
          <ComplaintRows complaints={list.items} />
        )}
        <MoreButton list={list} />
      </LoadingContent>
    </>
  );
}

/** The rows of complaints — the list, a user's tab, an order's card. */
export function ComplaintRows({
  complaints,
  hide = [],
}: {
  complaints: readonly AdminComplaint[];
  hide?: readonly ("user" | "supplier" | "order")[];
}) {
  return (
    <div className="table-wrap">
      <table className="admin-table">
        <thead>
          <tr>
            <th scope="col">Причина</th>
            {!hide.includes("order") && <th scope="col">Заявка</th>}
            {!hide.includes("user") && <th scope="col">Пользователь</th>}
            {!hide.includes("supplier") && <th scope="col">Поставщик</th>}
            <th scope="col">Статус</th>
            <th scope="col">Подана</th>
          </tr>
        </thead>
        <tbody>
          {complaints.map((complaint) => (
            <tr key={complaint.id}>
              <td>
                <div className="cell-stack">
                  <AppLink href={complaintPath(complaint.id)}>
                    {COMPLAINT_REASON_TEXT[complaint.reason]}
                  </AppLink>
                  {complaint.text && (
                    <span className="ac-text-caption ac-muted long-text">{complaint.text}</span>
                  )}
                </div>
              </td>
              {!hide.includes("order") && (
                <td className="num nowrap">
                  <AppLink href={orderPath(complaint.order.id)}>№ {complaint.order.number}</AppLink>
                  {complaint.order.isTest && (
                    <span className="ac-text-caption ac-muted"> · тестовая</span>
                  )}
                </td>
              )}
              {!hide.includes("user") && (
                <td>
                  <AppLink href={userPath(complaint.user.accountId)}>
                    {complaint.user.name ?? "Без имени"}
                  </AppLink>
                  <span className="ac-text-caption ac-muted num"> {complaint.user.phone}</span>
                </td>
              )}
              {!hide.includes("supplier") && (
                <td className="long-text">
                  <AppLink href={supplierPath(complaint.supplier.id)}>
                    {complaint.supplier.name}
                  </AppLink>
                </td>
              )}
              <td>
                <span className={`status ${complaintTone(complaint.status)}`}>
                  {COMPLAINT_STATUS_TEXT[complaint.status]}
                </span>
              </td>
              <td className="ac-text-body-s num nowrap">{formatMoment(complaint.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A-REV-02 «Карточка жалобы»: the reason and the text, the order, the user
 * (the number partly hidden, «Показать номер» with a trace), the supplier;
 * «Взять в работу» and «Решить…» with the internal comment (the user only
 * learns «Жалоба рассмотрена»), each with the version shown; a colleague's
 * earlier action comes back in words.
 */
export function ComplaintCard({ complaintId }: { complaintId: string }) {
  const toast = useToast();
  const online = useOnline();
  const card = useLoad<AdminComplaintResponse>(
    () => apiClient.getAdminComplaint({ complaintId }),
    `complaint:${complaintId}`,
  );
  const complaint =
    card.data && card.data.complaint.id === complaintId ? card.data.complaint : undefined;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [historyKey, setHistoryKey] = useState(0);

  const act = async (send: () => Promise<AdminComplaintResponse>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      const answer = await send();
      card.replace(answer);
      setResolving(false);
      setHistoryKey((key) => key + 1);
      toast.show(done);
    } catch (thrown) {
      setError(complaintErrorText(thrown));
      card.reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page__head page__head--back">
        <IconButton icon="arrowLeft" label="Назад к жалобам" onClick={() => goBack("complaints")} />
        <div className="cell-stack">
          <h1 className="ac-text-title-l page__title">
            {complaint ? `Жалоба по заявке № ${complaint.order.number}` : "Жалоба"}
          </h1>
          {complaint && (
            <span className="ac-text-body-s ac-muted supplier-head__line">
              <span className={`status ${complaintTone(complaint.status)}`}>
                {COMPLAINT_STATUS_TEXT[complaint.status]}
              </span>
              <span>подана {formatMoment(complaint.createdAt)}</span>
            </span>
          )}
        </div>
        <Button variant="secondary" size="s" icon="refresh" onClick={card.reload}>
          Обновить
        </Button>
      </div>
      <LoadError error={card.error} retry={card.reload} />
      {error && !resolving && <Banner tone="warning">{error}</Banner>}
      <LoadingContent
        ready={complaint !== undefined}
        indicator={card.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={5} label="Загрузка" />}
      >
        {complaint && (
          <div className="detail-stack">
            <div className="button-row">
              {complaint.status === "new" && (
                <Button
                  disabled={!online}
                  loading={busy && !resolving}
                  onClick={() =>
                    act(
                      () =>
                        apiClient.takeAdminComplaint(
                          { complaintId },
                          { expectedVersion: complaint.version },
                        ),
                      "Жалоба взята в работу",
                    )
                  }
                >
                  Взять в работу
                </Button>
              )}
              {complaint.status !== "resolved" && (
                <Button
                  variant="secondary"
                  disabled={!online}
                  onClick={() => {
                    setError(null);
                    setResolving(true);
                  }}
                >
                  Решить…
                </Button>
              )}
            </div>
            <section className="card-section">
              <dl className="facts">
                <div>
                  <dt>Причина</dt>
                  <dd>{COMPLAINT_REASON_TEXT[complaint.reason]}</dd>
                </div>
                <div>
                  <dt>Текст</dt>
                  <dd className="long-text">
                    {complaint.text ?? <span className="ac-muted">без текста</span>}
                  </dd>
                </div>
                <div>
                  <dt>Заявка</dt>
                  <dd>
                    <AppLink href={orderPath(complaint.order.id)}>
                      № {complaint.order.number}
                    </AppLink>
                    {complaint.order.isTest && <span className="ac-muted"> · тестовая</span>}
                  </dd>
                </div>
                <div>
                  <dt>Пользователь</dt>
                  <dd>
                    <AppLink href={userPath(complaint.user.accountId)}>
                      {complaint.user.name ?? "Без имени"}
                    </AppLink>
                    <br />
                    <PhoneReveal
                      phone={complaint.user.phone}
                      subject="order"
                      id={complaint.order.id}
                    />
                  </dd>
                </div>
                <div>
                  <dt>Поставщик</dt>
                  <dd className="long-text">
                    <AppLink href={supplierPath(complaint.supplier.id)}>
                      {complaint.supplier.name}
                    </AppLink>
                  </dd>
                </div>
                {complaint.takenBy && (
                  <div>
                    <dt>В работе</dt>
                    <dd>
                      {complaint.takenBy.name ?? "администратор"} ·{" "}
                      {formatMoment(complaint.takenAt)}
                    </dd>
                  </div>
                )}
                {complaint.resolvedBy && (
                  <div>
                    <dt>Решена</dt>
                    <dd>
                      {complaint.resolvedBy.name ?? "администратор"} ·{" "}
                      {formatMoment(complaint.resolvedAt)}
                    </dd>
                  </div>
                )}
                {complaint.comment && (
                  <div>
                    <dt>Внутренний комментарий</dt>
                    <dd className="long-text">{complaint.comment}</dd>
                  </div>
                )}
              </dl>
            </section>
            <section className="card-section">
              <h2 className="ac-text-heading">История</h2>
              <JournalHistory
                filter={{ entityType: "complaint", entityId: complaintId }}
                loadKey={`complaint-history:${complaintId}:${historyKey}`}
                caption="История жалобы"
              />
            </section>
          </div>
        )}
      </LoadingContent>
      {complaint && resolving && (
        <ReasonDialog
          open
          title="Решить жалобу"
          confirm="Решить"
          reasonLabel="Внутренний комментарий (обязательно, пользователь его не видит)"
          busy={busy}
          error={error && <p className="dialog-error">{error}</p>}
          onClose={() => setResolving(false)}
          onConfirm={(comment) =>
            act(
              () =>
                apiClient.resolveAdminComplaint(
                  { complaintId },
                  { expectedVersion: complaint.version, comment },
                ),
              "Жалоба решена",
            )
          }
        >
          <WasNow was={COMPLAINT_STATUS_TEXT[complaint.status]} now="Решена" />
          <p className="ac-text-body-s">
            Пользователь увидит на заявке «Жалоба рассмотрена». Ответ по существу даётся вне
            приложения.
          </p>
        </ReasonDialog>
      )}
    </>
  );
}
