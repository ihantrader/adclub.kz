import type {
  AdminAssistantComplaint,
  AdminAssistantComplaintPage,
  AdminAssistantComplaintResponse,
} from "@adclub/contracts";
import {
  ActionBar,
  Banner,
  Button,
  EmptyState,
  IconButton,
  LoadingContent,
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
import { StatusChips } from "../layout/filters";
import { ReasonDialog } from "../layout/ReasonDialog";
import { AppLink, Header, RowTitle, rowLink, Table, type Column } from "../layout/layout";
import { PhoneReveal } from "../people/PhoneReveal";
import { assistantComplaintPath, catalogItemPath, routePaths, userPath } from "../router";
import { useAddressFilters, WasNow } from "../suppliers/shared";
import { useLoad } from "../use-load";
import { MoreButton, usePaged } from "../vehicles/shared";
import {
  ASSISTANT_INTENT_TEXT,
  ASSISTANT_KIND_TEXT,
  ASSISTANT_REASON_TEXT,
  ASSISTANT_STATUS_FILTERS,
  ASSISTANT_STATUS_TEXT,
  assistantComplaintErrorText,
  carText,
  jsonText,
  TOOL_TEXT,
  usdText,
} from "./assistant-words";
import "../reviews/reviews.css";
import "./assistant.css";

type StatusFilter = (typeof ASSISTANT_STATUS_FILTERS)[number]["value"];

function statusOf(value: string | null): StatusFilter {
  return ASSISTANT_STATUS_FILTERS.some((filter) => filter.value === value)
    ? (value as StatusFilter)
    : "new";
}

function whoText(complaint: AdminAssistantComplaint): string {
  return complaint.dialog.user
    ? (complaint.dialog.user.name ?? "Имя не указано")
    : "Гость (устройство)";
}

/**
 * «Помощник» (TASK-062): complaints about answers of the AI Pilot, new ones
 * first by default; a row opens the complaint with the whole dialog.
 */
export function AssistantComplaints() {
  const { query, set } = useAddressFilters();
  const status = statusOf(query.get("status"));
  const [counts, setCounts] = useState<AdminAssistantComplaintPage["counts"] | null>(null);
  const list = usePaged<AdminAssistantComplaint>(async (cursor) => {
    const page = await apiClient.listAdminAssistantComplaints({
      query: { status, limit: 30, offset: cursor ? Number(cursor) : 0 },
    });
    setCounts(page.counts);
    return {
      items: page.complaints,
      total: page.total,
      nextCursor: page.nextOffset === null ? null : String(page.nextOffset),
    };
  }, status);
  const columns: Column[] = [
    { key: "complaint", header: "Жалоба" },
    { key: "answer", header: "Ответ помощника" },
    { key: "who", header: "Кто", width: 180 },
    { key: "cost", header: "Диалог", width: 140 },
    { key: "status", header: "Статус", width: 120 },
    { key: "created", header: "Подана", width: 140 },
  ];

  return (
    <>
      <Header
        title="Помощник"
        subtitle="Жалобы на ответы AI Pilot"
        actions={
          <IconButton icon="refresh" label="Обновить" size={20} onClick={list.first.reload} />
        }
      />
      <div className="filters__group review-filters">
        <StatusChips<StatusFilter>
          label="Статус жалобы"
          value={status}
          allLabel={null}
          chips={ASSISTANT_STATUS_FILTERS.map((filter) => ({
            value: filter.value,
            label: filter.label,
            count:
              filter.value === "all"
                ? counts
                  ? counts.new + counts.resolved
                  : undefined
                : counts?.[filter.value],
          }))}
          onChange={(next) => set({ status: next === "new" ? undefined : next })}
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
          <TableToolbar total={list.items.length === 0 ? null : list.total} />
          {list.items.length === 0 ? (
            <EmptyState
              icon="circleCheck"
              title={status === "new" ? "Новых жалоб нет" : "Жалоб нет"}
              text="Жалобы пользователей на ответы помощника появятся здесь."
            />
          ) : (
            <Table label="Жалобы на помощника" columns={columns}>
              {list.items.map((complaint) => (
                <tr key={complaint.id} {...rowLink(assistantComplaintPath(complaint.id))}>
                  <td>
                    <RowTitle
                      href={assistantComplaintPath(complaint.id)}
                      sub={
                        complaint.text ? (
                          <span className="clamp" title={complaint.text}>
                            {complaint.text}
                          </span>
                        ) : undefined
                      }
                    >
                      {ASSISTANT_REASON_TEXT[complaint.reason]}
                    </RowTitle>
                  </td>
                  <td className="ac-text-body-s">
                    <span className="clamp" title={complaint.message.text ?? undefined}>
                      {complaint.message.text ?? <span className="ac-muted">Текст обезличен</span>}
                    </span>
                  </td>
                  <td className="ac-text-body-s">{whoText(complaint)}</td>
                  <td className="ac-text-body-s nowrap">
                    {complaint.dialog.turns} ход. · {usdText(complaint.dialog.costUsd)}
                  </td>
                  <td>
                    <StatusBadge
                      kind="complaint"
                      status={complaint.status === "new" ? "new" : "resolved"}
                    >
                      {ASSISTANT_STATUS_TEXT[complaint.status]}
                    </StatusBadge>
                  </td>
                  <td className="ac-text-body-s nowrap">{formatMoment(complaint.createdAt)}</td>
                </tr>
              ))}
            </Table>
          )}
          <MoreButton list={list} />
        </div>
      </LoadingContent>
    </>
  );
}

/**
 * A complaint about an answer of the assistant (TASK-062): the reason and
 * the text, who (a person — the number hidden, «Показать номер»; or a
 * guest's device), the car and the city, the dialog in words — each message,
 * and of each answer the tool calls with their arguments and cut results,
 * the AI calls, the models and the cost — and «Решить…» with an internal
 * comment and the version shown.
 */
export function AssistantComplaintCard({ complaintId }: { complaintId: string }) {
  const toast = useToast();
  const online = useOnline();
  const card = useLoad<AdminAssistantComplaintResponse>(
    () => apiClient.getAdminAssistantComplaint({ complaintId }),
    `assistant-complaint:${complaintId}`,
  );
  const data = card.data && card.data.complaint.id === complaintId ? card.data : undefined;
  const complaint = data?.complaint;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [historyKey, setHistoryKey] = useState(0);

  const resolve = async (comment: string) => {
    if (!complaint) return;
    setBusy(true);
    setError(null);
    try {
      const answer = await apiClient.resolveAdminAssistantComplaint(
        { complaintId },
        { expectedVersion: complaint.version, comment },
      );
      card.replace(answer);
      setResolving(false);
      setHistoryKey((key) => key + 1);
      toast.show("Жалоба решена");
    } catch (thrown) {
      setError(assistantComplaintErrorText(thrown));
      card.reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Header
        crumbs={[{ label: "Помощник", href: routePaths.assistantComplaints }]}
        title="Жалоба на ответ помощника"
        subtitle={
          complaint && (
            <>
              <StatusBadge
                kind="complaint"
                status={complaint.status === "new" ? "new" : "resolved"}
              >
                {ASSISTANT_STATUS_TEXT[complaint.status]}
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
        ready={data !== undefined}
        indicator={card.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={6} label="Загрузка" />}
      >
        {data && complaint && (
          <div className="detail-stack">
            <section className="card complaint-card" aria-labelledby="assistant-complaint-title">
              <h2 id="assistant-complaint-title" className="card__title">
                Жалоба
              </h2>
              <dl className="kv">
                <dt>Причина</dt>
                <dd>{ASSISTANT_REASON_TEXT[complaint.reason]}</dd>
                {complaint.text && (
                  <>
                    <dt>Текст</dt>
                    <dd className="complaint-text">{complaint.text}</dd>
                  </>
                )}
                <dt>Кто</dt>
                <dd>
                  {complaint.dialog.user ? (
                    <span className="cell-stack">
                      <AppLink href={userPath(complaint.dialog.user.accountId)}>
                        {complaint.dialog.user.name ?? "Имя не указано"}
                      </AppLink>
                      <PhoneReveal
                        phone={complaint.dialog.user.phone}
                        subject="account"
                        id={complaint.dialog.user.accountId}
                      />
                    </span>
                  ) : (
                    "Гость (устройство без входа)"
                  )}
                </dd>
                <dt>Автомобиль</dt>
                <dd>{carText(complaint.dialog.car)}</dd>
                <dt>Город</dt>
                <dd>{complaint.dialog.city ?? "Не выбран"}</dd>
                <dt>Диалог</dt>
                <dd>
                  {complaint.dialog.turns} ход. · ИИ {usdText(complaint.dialog.costUsd)} · язык{" "}
                  {complaint.dialog.language}
                </dd>
              </dl>
              {complaint.status === "resolved" ? (
                <p className="complaint-none">Действий нет: жалоба решена</p>
              ) : (
                <ActionBar
                  compact
                  label="Действия с жалобой"
                  main={
                    <Button
                      size="m"
                      disabled={!online}
                      onClick={() => {
                        setError(null);
                        setResolving(true);
                      }}
                    >
                      Решить…
                    </Button>
                  }
                  others={[]}
                />
              )}
            </section>
            {(complaint.resolvedBy || complaint.comment) && (
              <section className="card complaint-card" aria-labelledby="assistant-decision">
                <h2 id="assistant-decision" className="card__title">
                  Решение
                </h2>
                <dl className="kv">
                  {complaint.resolvedBy && (
                    <>
                      <dt>Решил</dt>
                      <dd className="nowrap">
                        {complaint.resolvedBy.name ?? "администратор"},{" "}
                        {formatMoment(complaint.resolvedAt)}
                      </dd>
                    </>
                  )}
                  {complaint.comment && (
                    <>
                      <dt>Внутренний комментарий</dt>
                      <dd className="complaint-text">{complaint.comment}</dd>
                    </>
                  )}
                </dl>
              </section>
            )}
            <section className="section" aria-labelledby="assistant-dialog">
              <div className="section__head">
                <h2 id="assistant-dialog" className="section__title">
                  Диалог
                </h2>
              </div>
              <div className="detail-stack">
                {data.messages.map((message) => (
                  <article
                    key={message.id}
                    className="card complaint-card"
                    aria-label={message.role === "user" ? "Пользователь" : "Помощник"}
                  >
                    <div className="badges">
                      <TypeMark icon={message.role === "user" ? "user" : "info"}>
                        {message.role === "user" ? "Пользователь" : "Помощник"}
                      </TypeMark>
                      {message.kind && <span>{ASSISTANT_KIND_TEXT[message.kind]}</span>}
                      {message.intent && <span>{ASSISTANT_INTENT_TEXT[message.intent]}</span>}
                      {message.id === complaint.message.id && (
                        <StatusBadge kind="complaint" status="new">
                          На этот ответ жалоба
                        </StatusBadge>
                      )}
                      <span className="ac-muted nowrap">{formatMoment(message.createdAt)}</span>
                    </div>
                    <p className="complaint-text">
                      {message.text ?? <span className="ac-muted">Текст обезличен</span>}
                    </p>
                    {message.role === "assistant" && (
                      <dl className="kv">
                        {message.itemIds.length > 0 && (
                          <>
                            <dt>Позиции</dt>
                            <dd>
                              <span className="cell-stack">
                                {message.itemIds.map((itemId) => (
                                  <AppLink key={itemId} href={catalogItemPath(itemId)}>
                                    {itemId}
                                  </AppLink>
                                ))}
                              </span>
                            </dd>
                          </>
                        )}
                        {message.droppedItems > 0 && (
                          <>
                            <dt>Отброшено проверкой</dt>
                            <dd>{message.droppedItems}</dd>
                          </>
                        )}
                        <dt>Вызовы ИИ</dt>
                        <dd>
                          {message.ai.calls} · {message.ai.models.join(", ") || "—"} ·{" "}
                          {usdText(message.ai.costUsd)}
                        </dd>
                        {message.toolCalls.length > 0 && (
                          <>
                            <dt>Инструменты</dt>
                            <dd>
                              <ol className="cell-stack">
                                {message.toolCalls.map((tool, index) => (
                                  <li key={index} className="ac-text-body-s assistant-tool">
                                    <strong>{TOOL_TEXT[tool.name] ?? tool.name}</strong>{" "}
                                    <code>{jsonText(tool.arguments, 300)}</code>
                                    <br />
                                    <span className="ac-muted">→ {jsonText(tool.result)}</span>
                                  </li>
                                ))}
                              </ol>
                            </dd>
                          </>
                        )}
                      </dl>
                    )}
                  </article>
                ))}
              </div>
            </section>
            <section className="section" aria-labelledby="assistant-history">
              <div className="section__head">
                <h2 id="assistant-history" className="section__title">
                  История
                </h2>
              </div>
              <JournalHistory
                filter={{ entityType: "assistant_complaint", entityId: complaintId }}
                loadKey={`assistant-complaint-history:${complaintId}:${String(historyKey)}`}
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
          maxLength={2000}
          busy={busy}
          error={error && <p className="dialog-error">{error}</p>}
          onClose={() => setResolving(false)}
          onConfirm={resolve}
        >
          <WasNow was={ASSISTANT_STATUS_TEXT[complaint.status]} now="Решена" />
        </ReasonDialog>
      )}
    </>
  );
}
