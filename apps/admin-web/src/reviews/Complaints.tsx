import {
  complaintReasonSchema,
  type AdminComplaint,
  type AdminComplaintListQuery,
  type AdminComplaintPage,
  type AdminComplaintResponse,
  type ComplaintReasonValue,
} from "@adclub/contracts";
import {
  ActionBar,
  Banner,
  Button,
  EmptyState,
  IconButton,
  LoadingContent,
  SearchSelect,
  SkeletonList,
  StatusBadge,
  TableToolbar,
  TypeMark,
  useToast,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useState } from "react";
import { apiClient } from "../api";
import { JournalHistory } from "../audit/JournalHistory";
import { loadErrorText } from "../errors";
import { formatMoment } from "../format";
import { FilterSelect, StatusChips } from "../layout/filters";
import { AppLink, Header, RowTitle, rowLink, Table, type Column } from "../layout/layout";
import { useSupplierChoice } from "../orders/Orders";
import { PhoneReveal } from "../people/PhoneReveal";
import { complaintPath, orderPath, routePaths, supplierPath, userPath } from "../router";
import { createChoiceSources } from "../search-select/sources";
import { useAddressFilters, WasNow } from "../suppliers/shared";
import { useLoad } from "../use-load";
import { MoreButton, usePaged } from "../vehicles/shared";
import { ReasonDialog } from "../layout/ReasonDialog";
import { ReviewSectionHeader } from "./Reviews";
import {
  COMPLAINT_REASON_TEXT,
  COMPLAINT_STATUS_FILTERS,
  COMPLAINT_STATUS_TEXT,
  complaintChipCount,
  complaintErrorText,
} from "./review-words";
import "./reviews.css";

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

/** «Имя, 14 окт., 18:41» of an administrator's step — one line, never split. */
function byAt(name: string | null | undefined, at: string | null | undefined): string {
  return `${name ?? "администратор"}, ${formatMoment(at)}`;
}

/** A list of complaints by the filters given (offset pages), with the counts by status. */
export function useComplaintList(filter: Omit<AdminComplaintListQuery, "limit" | "offset">) {
  const [counts, setCounts] = useState<AdminComplaintPage["counts"] | null>(null);
  const list = usePaged<AdminComplaint>(async (cursor) => {
    const page: AdminComplaintPage = await apiClient.listAdminComplaints({
      query: { ...filter, limit: 30, offset: cursor ? Number(cursor) : 0 },
    });
    setCounts(page.counts);
    return {
      items: page.complaints,
      total: page.total,
      nextCursor: page.nextOffset === null ? null : String(page.nextOffset),
    };
  }, JSON.stringify(filter));
  return { list, counts };
}

/**
 * A-REV-02 «Жалобы» (SCREENS 7.7; TASK-049, TASK-080): the status as chips
 * with their counts (new and in work by default), the reason and the
 * supplier in one row, all in the address; a row opens the complaint.
 */
export function Complaints() {
  const { query, set } = useAddressFilters();
  const status = statusOf(query.get("status"));
  const reason = reasonOf(query.get("reason"));
  const supplierId = query.get("supplierId") ?? undefined;
  const { list, counts } = useComplaintList({
    status: status === "all" ? undefined : status,
    reason,
    supplierId,
  });
  const supplier = useSupplierChoice(supplierId ?? null, list.items);
  const filtered = reason !== undefined || supplierId !== undefined || status !== "open";
  const reset = () => set({ status: undefined, reason: undefined, supplierId: undefined });

  return (
    <>
      <ReviewSectionHeader active="complaints" onRefresh={list.first.reload} />
      <div className="filters__group review-filters">
        <div className="filters">
          <FilterSelect<ComplaintReasonValue>
            label="Причина"
            value={reason}
            options={complaintReasonSchema.options.map((value) => ({
              value,
              label: COMPLAINT_REASON_TEXT[value],
            }))}
            onChange={(next) => set({ reason: next })}
          />
          <SearchSelect
            compact
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
        <StatusChips<StatusFilter>
          label="Статус жалобы"
          value={status}
          allLabel={null}
          chips={COMPLAINT_STATUS_FILTERS.map((filter) => ({
            value: filter.value,
            label: filter.label,
            count: complaintChipCount(filter.value, counts),
          }))}
          onChange={(next) => set({ status: next === "open" ? undefined : next })}
        />
      </div>
      {list.first.error !== undefined && (
        <Banner
          tone="danger"
          action={
            <Button variant="text" size="s" onClick={list.first.reload}>
              Повторить
            </Button>
          }
        >
          {loadErrorText(list.first.error)}
        </Banner>
      )}
      <LoadingContent
        ready={list.first.data !== undefined}
        indicator={list.first.indicator}
        label="Загрузка"
        swapKey={list.first.answerKey}
        skeleton={<SkeletonList rows={5} label="Загрузка" />}
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
            filtered ? (
              <EmptyState
                icon="search"
                title="Ничего не нашлось"
                text="Измените отборы"
                action={
                  <Button variant="secondary" onClick={reset}>
                    Сбросить фильтры
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon="circleCheck"
                title="Новых жалоб нет"
                text="Жалобы пользователей на заявки появятся здесь."
              />
            )
          ) : (
            <ComplaintRows complaints={list.items} />
          )}
          <MoreButton list={list} />
        </div>
      </LoadingContent>
    </>
  );
}

/**
 * The rows of complaints (TASK-080) — the list, a user's tab, an order's
 * card: the reason (the name of the row, the text muted under it), the
 * order, the user, the supplier, the status, when. The row opens the
 * complaint; nothing else in it is a link (X1).
 */
export function ComplaintRows({
  complaints,
  hide = [],
}: {
  complaints: readonly AdminComplaint[];
  hide?: readonly ("user" | "supplier" | "order")[];
}) {
  const columns: Column[] = [
    { key: "complaint", header: "Жалоба" },
    ...(hide.includes("order") ? [] : [{ key: "order", header: "Заявка", width: 130 }]),
    ...(hide.includes("user") ? [] : [{ key: "user", header: "Пользователь", width: 200 }]),
    ...(hide.includes("supplier") ? [] : [{ key: "supplier", header: "Поставщик", width: 200 }]),
    { key: "status", header: "Статус", width: 140 },
    { key: "created", header: "Подана", width: 140 },
  ];
  return (
    <Table label="Жалобы" columns={columns}>
      {complaints.map((complaint) => (
        <tr key={complaint.id} {...rowLink(complaintPath(complaint.id))}>
          <td>
            <RowTitle
              href={complaintPath(complaint.id)}
              sub={
                complaint.text ? (
                  <span className="clamp" title={complaint.text}>
                    {complaint.text}
                  </span>
                ) : undefined
              }
            >
              {COMPLAINT_REASON_TEXT[complaint.reason]}
            </RowTitle>
          </td>
          {!hide.includes("order") && (
            <td className="ac-text-body-s">
              <span className="badges">
                <span className="nowrap">№ {complaint.order.number}</span>
                {complaint.order.isTest && <TypeMark icon="info">Тест</TypeMark>}
              </span>
            </td>
          )}
          {!hide.includes("user") && (
            <td>
              <span className="review-line ac-text-body-s" title={complaint.user.name ?? undefined}>
                {complaint.user.name ?? <span className="ac-muted">Имя не указано</span>}
              </span>
              <span className="review-line review-line--caption">{complaint.user.phone}</span>
            </td>
          )}
          {!hide.includes("supplier") && (
            <td className="ac-text-body-s">
              <span className="clamp" title={complaint.supplier.name}>
                {complaint.supplier.name}
              </span>
            </td>
          )}
          <td>
            <StatusBadge kind="complaint" status={complaint.status}>
              {COMPLAINT_STATUS_TEXT[complaint.status]}
            </StatusBadge>
          </td>
          <td className="ac-text-body-s nowrap">{formatMoment(complaint.createdAt)}</td>
        </tr>
      ))}
    </Table>
  );
}

/**
 * A-REV-02 «Карточка жалобы» (TASK-049, TASK-080): the crumbs of the
 * section, the status under the title; the card of the complaint — the
 * reason and the text (when there is one), the order, the user (the number
 * hidden, «Показать номер» with a trace), the supplier, who took it — and
 * its actions: «Взять в работу» and «Решить…» with the internal comment
 * (the user only learns «Жалоба рассмотрена»), each with the version shown;
 * a resolved one says «Действий нет». The decision is its own card.
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
      // A colleague acted first: the card shows the complaint as it is now.
      card.reload();
    } finally {
      setBusy(false);
    }
  };

  const take = complaint?.status === "new" && (
    <Button
      size="m"
      disabled={!online}
      loading={busy && !resolving}
      onClick={() =>
        act(
          () =>
            apiClient.takeAdminComplaint({ complaintId }, { expectedVersion: complaint.version }),
          "Жалоба взята в работу",
        )
      }
    >
      Взять в работу
    </Button>
  );
  const resolve = complaint && complaint.status !== "resolved" && (
    <Button
      size="m"
      variant={complaint.status === "new" ? "secondary" : "primary"}
      disabled={!online}
      onClick={() => {
        setError(null);
        setResolving(true);
      }}
    >
      Решить…
    </Button>
  );

  return (
    <>
      <Header
        crumbs={[
          { label: "Отзывы и жалобы", href: routePaths.reviews },
          { label: "Жалобы", href: routePaths.complaints },
        ]}
        title={complaint ? `Жалоба по заявке № ${String(complaint.order.number)}` : "Жалоба"}
        subtitle={
          complaint && (
            <>
              <StatusBadge kind="complaint" status={complaint.status}>
                {COMPLAINT_STATUS_TEXT[complaint.status]}
              </StatusBadge>
              <span className="nowrap">подана {formatMoment(complaint.createdAt)}</span>
            </>
          )
        }
        actions={<IconButton icon="refresh" label="Обновить" size={20} onClick={card.reload} />}
      />
      {card.error !== undefined && (
        <Banner
          tone="danger"
          action={
            <Button variant="text" size="s" onClick={card.reload}>
              Повторить
            </Button>
          }
        >
          {loadErrorText(card.error)}
        </Banner>
      )}
      {error && !resolving && <Banner tone="warning">{error}</Banner>}
      <LoadingContent
        ready={complaint !== undefined}
        indicator={card.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={5} label="Загрузка" />}
      >
        {complaint && (
          <div className="detail-stack">
            <section className="card complaint-card" aria-labelledby="complaint-title">
              <h2 id="complaint-title" className="card__title">
                Жалоба
              </h2>
              <dl className="kv">
                <dt>Причина</dt>
                <dd>{COMPLAINT_REASON_TEXT[complaint.reason]}</dd>
                {complaint.text && (
                  <>
                    <dt>Текст</dt>
                    <dd className="complaint-text">{complaint.text}</dd>
                  </>
                )}
                <dt>Заявка</dt>
                <dd>
                  <span className="badges">
                    <AppLink href={orderPath(complaint.order.id)}>
                      № {complaint.order.number}
                    </AppLink>
                    {complaint.order.isTest && <TypeMark icon="info">Тест</TypeMark>}
                  </span>
                </dd>
                <dt>Пользователь</dt>
                <dd>
                  <span className="cell-stack">
                    <AppLink href={userPath(complaint.user.accountId)}>
                      {complaint.user.name ?? "Имя не указано"}
                    </AppLink>
                    <PhoneReveal
                      phone={complaint.user.phone}
                      subject="order"
                      id={complaint.order.id}
                    />
                  </span>
                </dd>
                <dt>Поставщик</dt>
                <dd>
                  <AppLink href={supplierPath(complaint.supplier.id)}>
                    {complaint.supplier.name}
                  </AppLink>
                </dd>
                {complaint.takenBy && (
                  <>
                    <dt>Взял в работу</dt>
                    <dd className="nowrap">{byAt(complaint.takenBy.name, complaint.takenAt)}</dd>
                  </>
                )}
              </dl>
              {complaint.status === "resolved" ? (
                <p className="complaint-none">Действий нет: жалоба решена</p>
              ) : (
                <ActionBar
                  compact
                  label="Действия с жалобой"
                  main={take || resolve}
                  others={take ? [resolve] : []}
                />
              )}
            </section>
            {(complaint.resolvedBy || complaint.comment) && (
              <section className="card complaint-card" aria-labelledby="decision-title">
                <h2 id="decision-title" className="card__title">
                  Решение
                </h2>
                <dl className="kv">
                  {complaint.resolvedBy && (
                    <>
                      <dt>Решил</dt>
                      <dd className="nowrap">
                        {byAt(complaint.resolvedBy.name, complaint.resolvedAt)}
                      </dd>
                    </>
                  )}
                  {complaint.comment && (
                    <>
                      <dt>Внутренний комментарий</dt>
                      <dd className="complaint-text">
                        {complaint.comment}
                        <span className="kv__note">Пользователь его не видит</span>
                      </dd>
                    </>
                  )}
                </dl>
              </section>
            )}
            <section className="section" aria-labelledby="complaint-history">
              <div className="section__head">
                <h2 id="complaint-history" className="section__title">
                  История
                </h2>
              </div>
              <JournalHistory
                filter={{ entityType: "complaint", entityId: complaintId }}
                loadKey={`complaint-history:${complaintId}:${String(historyKey)}`}
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
          maxLength={1000}
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
