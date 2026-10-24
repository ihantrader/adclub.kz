import type {
  AdminSupplierCard,
  AdminSupplierMember,
  AdminSupplierMemberListResponse,
  AdminSupplierSession,
  AdminSupplierSessionListResponse,
} from "@adclub/contracts";
import {
  Badge,
  Banner,
  Button,
  Dialog,
  EmptyState,
  LoadingContent,
  MenuButton,
  SkeletonList,
  StatusBadge,
  TextField,
  useToast,
  type MenuAction,
} from "@adclub/ui";
import { useOnline } from "@adclub/web-session";
import { useState } from "react";
import { apiClient } from "../api";
import { formatMoment } from "../format";
import { FilterSelect } from "../layout/filters";
import { AppLink, Table } from "../layout/layout";
import { PhoneReveal } from "../people/PhoneReveal";
import { routePaths, withQuery } from "../router";
import { useLoad } from "../use-load";
import { LoadError } from "../vehicles/shared";
import { ReasonDialog, SaverError, useSupplierSaver } from "./shared";
import {
  addedByText,
  hiddenPhone,
  INVITATION_TEXT,
  ipText,
  mobilePhone,
  PHONE_HINT,
  sessionGroups,
  supplierErrorView,
} from "./supplier-words";

/** Sessions shown before «Показать все (N)» (X22). */
const FIRST_SESSIONS = 10;

type Confirm =
  | { kind: "session"; session: AdminSupplierSession }
  | { kind: "member-sessions"; member: AdminSupplierMember; count: number };

const MEMBER_COLUMNS = [
  { key: "member", header: "Сотрудник" },
  { key: "notifications", header: "Уведомления", width: 170 },
  { key: "invitation", header: "Приглашение", width: 250 },
  { key: "actions", header: "Действия", width: 64, actions: true, hiddenHeader: true },
];

const REMOVED_COLUMNS = [
  { key: "member", header: "Сотрудник" },
  { key: "removed", header: "Удалён", width: 240 },
  { key: "actions", header: "Действия", width: 200, actions: true, hiddenHeader: true },
];

const SESSION_COLUMNS = [
  { key: "device", header: "Устройство и сотрудник" },
  { key: "used", header: "Последний раз", width: 160 },
  { key: "expires", header: "Истекает", width: 140 },
  { key: "actions", header: "Действия", width: 120, actions: true, hiddenHeader: true },
];

/** «Отправлено» on a badge from «отправлено» of the words. */
function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The language of an employee's notifications as a small mark: «KK», «RU». */
function LanguageMark({ language }: { language: string }) {
  const code = language === "kk" ? "KK" : "RU";
  return (
    <span
      className="lang-mark"
      title={language === "kk" ? "Уведомления на казахском" : "Уведомления на русском"}
    >
      {code}
    </span>
  );
}

/**
 * «Сотрудники» of A-SUP-03 (SCREENS 7.4; TASK-036, TASK-080): the head of the
 * section with «+ Добавить», who receives the order notifications and the
 * limit (a link to the setting); each employee in one row — the name, the
 * number partly hidden with the eye (SCREENS 7.0), the notifications and
 * their language, the invitation with «Приглашение повторно», the rarer
 * actions in «⋯». The removed ones — who removed them and when — with
 * «Восстановить доступ» and its reason. The cabinet sessions: the first
 * ten, a filter by employee, alike ones in a row folded, «Показать все (N)».
 * A blocked company adds no employees and sends no invitations (D-070): the
 * buttons are not offered, and the server refuses anyway.
 */
export function SupplierMembers({
  card,
  onReload,
}: {
  card: AdminSupplierCard;
  onReload: () => void;
}) {
  const toast = useToast();
  const online = useOnline();
  const members = useLoad<AdminSupplierMemberListResponse>(
    () => apiClient.listAdminSupplierMembers({ supplierId: card.id }),
    `members:${card.id}`,
  );
  const [sessionsKey, setSessionsKey] = useState(0);
  const [adding, setAdding] = useState(false);
  const [restoring, setRestoring] = useState<AdminSupplierMember | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const restoreSaver = useSupplierSaver("supplier_member");
  const blocked = card.state === "blocked";

  const list = members.data?.members ?? [];
  const current = list.filter((member) => member.status === "active");
  const removed = list.filter((member) => member.status === "removed");
  const summary = members.data?.notifications;

  // How many sessions each employee has: «Завершить все сессии (N)».
  const counts = useLoad<Record<string, number>>(
    async () => {
      const entries = await Promise.all(
        current.map(async (member) => {
          const page = await apiClient.listSupplierSessions(
            { supplierId: card.id },
            { query: { limit: 1, memberId: member.id } },
          );
          // Before the server pages them, every session comes back: count them.
          return [member.id, page.total ?? page.sessions.length] as const;
        }),
      );
      return Object.fromEntries(entries);
    },
    `session-counts:${card.id}:${current.map((member) => member.id).join(",")}:${sessionsKey}`,
  );

  const reload = () => {
    members.reload();
    setSessionsKey((key) => key + 1);
  };

  /** One action of a row: the server's refusal in words above the list. */
  const act = async (key: string, action: () => Promise<string>) => {
    setBusy(key);
    setProblem(null);
    try {
      toast.show(await action());
      reload();
    } catch (thrown) {
      setProblem(supplierErrorView(thrown).text);
      if (supplierErrorView(thrown).currentVersion !== null) onReload();
    } finally {
      setBusy(null);
    }
  };

  const resend = (member: AdminSupplierMember) =>
    void act(`invite:${member.id}`, async () => {
      await apiClient.resendSupplierInvitation({ supplierId: card.id, memberId: member.id });
      return `Приглашение отправлено в WhatsApp: ${member.displayName}`;
    });

  const menuOf = (member: AdminSupplierMember): MenuAction[] => {
    const count = counts.data?.[member.id] ?? 0;
    return [
      ...(!member.isContactPerson
        ? [
            {
              key: "contact",
              label: "Сделать контактным лицом",
              icon: "user" as const,
              disabled: !online || busy !== null,
              onSelect: () =>
                void act(`contact:${member.id}`, async () => {
                  await apiClient.setSupplierContactPerson({
                    supplierId: card.id,
                    memberId: member.id,
                  });
                  return `Контактное лицо: ${member.displayName}`;
                }),
            },
          ]
        : []),
      ...(count > 0
        ? [
            {
              key: "sessions",
              label: `Завершить все сессии (${count})`,
              icon: "logout" as const,
              destructive: true,
              disabled: !online,
              onSelect: () => setConfirm({ kind: "member-sessions", member, count }),
            },
          ]
        : []),
    ];
  };

  return (
    <div className="detail-stack">
      {problem && <Banner tone="danger">{problem}</Banner>}
      <LoadError error={members.error} retry={members.reload} />
      <section className="section">
        <div className="section__head">
          <h2 className="section__title">Сотрудники</h2>
          {!blocked && (
            <Button
              variant="secondary"
              size="s"
              icon="plus"
              disabled={!online}
              onClick={() => setAdding(true)}
            >
              Добавить
            </Button>
          )}
        </div>
        {summary && (
          <p className="section__note">
            Уведомления о заявках получают {summary.recipients} из {summary.limit}
            {summary.enabled > summary.recipients
              ? ` · ещё ${summary.enabled - summary.recipients} ждут места`
              : ""}{" "}
            ·{" "}
            <AppLink href={withQuery(routePaths.settings, { q: "max_notified_members" })}>
              Предел — в настройках
            </AppLink>
          </p>
        )}
        {blocked && (
          <Banner tone="warning">
            Компания заблокирована: добавлять сотрудников и отправлять приглашения нельзя, пока
            блокировка не снята. Контактное лицо, восстановление и сессии — доступны.
          </Banner>
        )}
        <LoadingContent
          ready={members.data !== undefined}
          indicator={members.indicator}
          label="Загрузка"
          skeleton={<SkeletonList rows={4} label="Загрузка" />}
        >
          {current.length === 0 ? (
            <EmptyState compact icon="users" title="Сотрудников нет" />
          ) : (
            <Table label="Сотрудники" columns={MEMBER_COLUMNS} className="members-table">
              {current.map((member) => {
                const actions = menuOf(member);
                return (
                  <tr key={member.id}>
                    <td>
                      <span className="cell-stack">
                        <span className="member-name">
                          <span
                            className="ac-text-body-strong cell-one-line"
                            title={member.displayName}
                          >
                            {member.displayName}
                          </span>
                          {member.isContactPerson && (
                            <Badge tone="neutral" icon="user">
                              Контактное лицо
                            </Badge>
                          )}
                        </span>
                        <span className="ac-text-body-s">
                          <PhoneReveal
                            phone={hiddenPhone(member.phone)}
                            subject="supplier_member"
                            id={member.id}
                          />
                        </span>
                        <span className="row-title__sub">
                          Добавил {addedByText(member)} · {formatMoment(member.createdAt)}
                          {member.restore &&
                            ` · восстановлен ${formatMoment(member.restore.at)}: ${member.restore.reason}`}
                        </span>
                      </span>
                    </td>
                    <td>
                      <span className="badges nowrap">
                        {member.receivesNotifications ? (
                          <Badge tone="success" icon="circleCheck">
                            Получает
                          </Badge>
                        ) : member.notificationsEnabled ? (
                          <Badge tone="warning" icon="clock">
                            Ждёт места
                          </Badge>
                        ) : (
                          <Badge tone="neutral" icon="minus">
                            Выключены
                          </Badge>
                        )}
                        <LanguageMark language={member.notificationLanguage} />
                      </span>
                    </td>
                    <td>
                      <span className="cell-stack">
                        {member.lastInvitation ? (
                          <span className="badges nowrap">
                            <StatusBadge kind="invitation" status={member.lastInvitation.status}>
                              {capitalized(INVITATION_TEXT[member.lastInvitation.status])}
                            </StatusBadge>
                            <span className="row-title__sub">
                              {formatMoment(
                                member.lastInvitation.sentAt ?? member.lastInvitation.createdAt,
                              )}
                            </span>
                          </span>
                        ) : (
                          <span className="ac-muted ac-text-body-s">Не отправлялось</span>
                        )}
                        {!blocked && (
                          <span>
                            <Button
                              variant="text"
                              size="s"
                              disabled={!online}
                              loading={busy === `invite:${member.id}`}
                              onClick={() => resend(member)}
                            >
                              Приглашение повторно
                            </Button>
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="admin-table__actions">
                      {actions.length > 0 && (
                        <MenuButton
                          size="s"
                          label={`Действия: ${member.displayName}`}
                          actions={actions}
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </Table>
          )}
        </LoadingContent>
      </section>

      <section className="section">
        <div className="section__head">
          <h2 className="section__title">Удалённые</h2>
        </div>
        {members.data !== undefined &&
          (removed.length === 0 ? (
            <EmptyState compact icon="users" title="Удалённых сотрудников нет" />
          ) : (
            <Table label="Удалённые сотрудники" columns={REMOVED_COLUMNS}>
              {removed.map((member) => (
                <tr key={member.id} className="row--muted">
                  <td>
                    <span className="cell-stack">
                      <span
                        className="ac-text-body-strong cell-one-line"
                        title={member.displayName}
                      >
                        {member.displayName}
                      </span>
                      <span className="row-title__sub nowrap">{hiddenPhone(member.phone)}</span>
                    </span>
                  </td>
                  <td>
                    <span className="cell-stack">
                      <span className="ac-text-body-s nowrap">
                        {formatMoment(member.removedAt)}
                      </span>
                      <span className="row-title__sub">
                        {member.removedByMember
                          ? `удалил(а) ${member.removedByMember.displayName}`
                          : "удалён командой оператора"}
                      </span>
                    </span>
                  </td>
                  <td className="admin-table__actions">
                    <Button
                      variant="secondary"
                      size="s"
                      disabled={!online}
                      onClick={() => {
                        restoreSaver.reset();
                        setRestoring(member);
                      }}
                    >
                      Восстановить доступ…
                    </Button>
                  </td>
                </tr>
              ))}
            </Table>
          ))}
      </section>

      <Sessions
        key={sessionsKey}
        supplierId={card.id}
        members={current}
        onEnd={(session) => setConfirm({ kind: "session", session })}
      />

      <AddMemberDialog
        open={adding}
        supplierId={card.id}
        onClose={() => setAdding(false)}
        onAdded={(text) => {
          setAdding(false);
          toast.show(text);
          reload();
        }}
      />

      <ReasonDialog
        open={restoring !== null}
        title="Восстановить доступ сотрудника"
        confirm="Восстановить доступ"
        busy={restoreSaver.saving}
        onClose={() => setRestoring(null)}
        onConfirm={(reason) => {
          const member = restoring;
          if (!member) return;
          let text: string | null = null;
          void restoreSaver
            .run(member.id, async () => {
              const answer = await apiClient.restoreSupplierMember(
                { supplierId: card.id, memberId: member.id },
                { reason },
              );
              text =
                `Доступ восстановлен: ${member.displayName}. Прежние сессии не вернутся — сотрудник войдёт заново` +
                (answer.memberOfOtherSuppliers > 0
                  ? `. Номер работает ещё в ${answer.memberOfOtherSuppliers} компаниях — тот доступ сохраняется`
                  : "");
            })
            .then(() => {
              if (text) {
                setRestoring(null);
                toast.show(text);
                reload();
              }
            });
        }}
        error={<SaverError saver={restoreSaver} onRefresh={reload} />}
      >
        {restoring && (
          <p className="ac-text-body-s">
            {restoring.displayName} ({hiddenPhone(restoring.phone)}) снова сможет войти в кабинет.
            Уведомления включатся, если есть место в пределе. Приглашение не отправляется само — при
            необходимости отправьте его повторно.
          </p>
        )}
      </ReasonDialog>

      <Dialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm?.kind === "session" ? "Завершить сессию" : "Завершить все сессии сотрудника"}
        actions={
          <>
            <Button
              loading={busy === "end"}
              onClick={() => {
                const target = confirm;
                if (!target) return;
                void act("end", async () => {
                  const answer =
                    target.kind === "session"
                      ? await apiClient.endSupplierSession({
                          supplierId: card.id,
                          sessionId: target.session.id,
                        })
                      : await apiClient.endSupplierSessions(
                          { supplierId: card.id },
                          { memberId: target.member.id },
                        );
                  return `Завершено сессий: ${answer.ended}`;
                }).then(() => setConfirm(null));
              }}
            >
              Завершить
            </Button>
            <Button variant="secondary" onClick={() => setConfirm(null)}>
              Отмена
            </Button>
          </>
        }
      >
        {confirm && (
          <p className="ac-text-body-s">
            {confirm.kind === "session"
              ? `${confirm.session.member.displayName} выйдет из кабинета на устройстве «${confirm.session.deviceName ?? "без названия"}».`
              : `${confirm.member.displayName} выйдет из кабинета на всех устройствах (${confirm.count}).`}{" "}
            Сотрудником он останется и сможет войти заново.
          </p>
        )}
      </Dialog>
    </div>
  );
}

/**
 * The cabinet sessions (X22): the first ten, most recently used first, a
 * filter by employee, the same employee on the same device in a row folded
 * into one row with «ещё N таких»; «Показать все (N)» reads the rest.
 */
function Sessions({
  supplierId,
  members,
  onEnd,
}: {
  supplierId: string;
  members: readonly AdminSupplierMember[];
  onEnd: (session: AdminSupplierSession) => void;
}) {
  const online = useOnline();
  const [memberId, setMemberId] = useState<string | undefined>(undefined);
  const [all, setAll] = useState(false);
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  const sessions = useLoad<AdminSupplierSessionListResponse>(
    () =>
      apiClient.listSupplierSessions(
        { supplierId },
        {
          query: {
            ...(all ? {} : { limit: FIRST_SESSIONS }),
            ...(memberId ? { memberId } : {}),
          },
        },
      ),
    `sessions:${supplierId}:${memberId ?? ""}:${all ? "all" : "first"}`,
  );
  const loaded = sessions.data?.sessions ?? [];
  // Before the server pages them, every session comes back: the first ten are cut here.
  const shown = all ? loaded : loaded.slice(0, FIRST_SESSIONS);
  const total = sessions.data?.total ?? loaded.length;
  const groups = sessionGroups(shown);

  return (
    <section className="section">
      <div className="section__head">
        <h2 className="section__title">Сессии кабинета</h2>
      </div>
      {members.length > 1 && (
        <div className="filters">
          <FilterSelect<string>
            label="Сотрудник"
            value={memberId}
            options={members.map((member) => ({ value: member.id, label: member.displayName }))}
            onChange={(next) => {
              setMemberId(next);
              setAll(false);
            }}
          />
        </div>
      )}
      <LoadError error={sessions.error} retry={sessions.reload} />
      <LoadingContent
        ready={sessions.data !== undefined}
        indicator={sessions.indicator}
        label="Загрузка"
        swapKey={sessions.answerKey}
        skeleton={<SkeletonList rows={3} label="Загрузка" />}
      >
        <div className="list-block">
          {shown.length === 0 ? (
            <EmptyState
              compact
              icon="devices"
              title={
                memberId
                  ? "Этот сотрудник сейчас не вошёл в кабинет"
                  : "Сейчас никто из сотрудников не вошёл в кабинет"
              }
            />
          ) : (
            <Table label="Сессии кабинета" columns={SESSION_COLUMNS}>
              {groups.flatMap((group) => {
                const open = unfolded.has(group.first.id);
                const rows = open ? [group.first, ...group.rest] : [group.first];
                return rows.map((session, index) => (
                  <tr key={session.id}>
                    <td>
                      <span className="cell-stack">
                        <span className="ac-text-body-s cell-one-line">
                          {session.deviceName ?? "Устройство не названо"}
                        </span>
                        <span className="row-title__sub">
                          {[
                            session.member.displayName,
                            ipText(session.ipHint),
                            session.clientVersion ? `версия ${session.clientVersion}` : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                        {index === 0 && group.rest.length > 0 && (
                          <span>
                            <Button
                              variant="text"
                              size="s"
                              aria-expanded={open}
                              onClick={() =>
                                setUnfolded((now) => {
                                  const next = new Set(now);
                                  if (open) next.delete(group.first.id);
                                  else next.add(group.first.id);
                                  return next;
                                })
                              }
                            >
                              {open ? "Свернуть" : `Ещё ${group.rest.length} таких`}
                            </Button>
                          </span>
                        )}
                      </span>
                    </td>
                    <td>
                      <span className="cell-stack">
                        <span className="ac-text-body-s nowrap">
                          {formatMoment(session.lastUsedAt)}
                        </span>
                        <span className="row-title__sub nowrap">
                          вход {formatMoment(session.createdAt)}
                        </span>
                      </span>
                    </td>
                    <td className="ac-text-body-s nowrap">{formatMoment(session.expiresAt)}</td>
                    <td className="admin-table__actions">
                      <Button
                        variant="text"
                        size="s"
                        destructive
                        disabled={!online}
                        onClick={() => onEnd(session)}
                      >
                        Завершить
                      </Button>
                    </td>
                  </tr>
                ));
              })}
            </Table>
          )}
          {!all && total > shown.length && (
            <Button variant="secondary" size="s" onClick={() => setAll(true)}>
              Показать все ({total.toLocaleString("ru-RU")})
            </Button>
          )}
        </div>
      </LoadingContent>
    </section>
  );
}

function AddMemberDialog({
  open,
  supplierId,
  onClose,
  onAdded,
}: {
  open: boolean;
  supplierId: string;
  onClose: () => void;
  onAdded: (text: string) => void;
}) {
  const online = useOnline();
  const saver = useSupplierSaver("supplier_member");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("+7");
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [shown, setShown] = useState(false);
  if (open !== shown) {
    setShown(open);
    if (open) {
      setName("");
      setPhone("+7");
      setProblems({});
      saver.reset();
    }
  }
  const submit = async () => {
    const found: Record<string, string> = {};
    if (!name.trim()) found.name = "Укажите имя";
    const normalized = mobilePhone(phone);
    if (!normalized) found.phone = PHONE_HINT;
    setProblems(found);
    if (Object.keys(found).length > 0 || !normalized) return;
    let text: string | null = null;
    await saver.run(null, async () => {
      const answer = await apiClient.addAdminSupplierMember(
        { supplierId },
        { name: name.trim(), phone: normalized },
      );
      const notes = [
        answer.memberOfOtherSuppliers > 0
          ? `номер уже работает ещё в ${answer.memberOfOtherSuppliers} компаниях`
          : null,
        answer.isAdministrator ? "номер — также администратор клуба" : null,
      ].filter(Boolean);
      text = `Сотрудник добавлен. Приглашение отправлено в WhatsApp${notes.length ? ` (${notes.join("; ")})` : ""}`;
    });
    if (text) onAdded(text);
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Добавить сотрудника"
      actions={
        <>
          <Button onClick={submit} loading={saver.saving} disabled={!online}>
            Добавить и отправить приглашение
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Отмена
          </Button>
        </>
      }
    >
      <div className="dialog-stack">
        <TextField
          label="Имя"
          value={name}
          onChange={(value) => {
            setName(value);
            setProblems({});
          }}
          maxLength={100}
          error={problems.name ?? saver.fieldError("name")}
        />
        <TextField
          label="Телефон (WhatsApp)"
          value={phone}
          onChange={(value) => {
            setPhone(value);
            setProblems({});
          }}
          type="tel"
          inputMode="tel"
          error={problems.phone ?? saver.fieldError("phone")}
        />
        <SaverError saver={saver} fields={["name", "phone"]} />
      </div>
    </Dialog>
  );
}
