import type {
  AdminSupplierCard,
  AdminSupplierMember,
  AdminSupplierMemberListResponse,
  AdminSupplierSession,
  AdminSupplierSessionListResponse,
} from "@adclub/contracts";
import {
  Banner,
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
import { formatMoment } from "../format";
import { useLoad } from "../use-load";
import { FormError, LoadError } from "../vehicles/shared";
import { ReasonDialog, useSupplierSaver } from "./shared";
import {
  addedByText,
  hiddenPhone,
  INVITATION_TEXT,
  mobilePhone,
  PHONE_HINT,
  supplierErrorView,
} from "./supplier-words";

type Confirm =
  | { kind: "session"; session: AdminSupplierSession }
  | { kind: "member-sessions"; member: AdminSupplierMember; count: number };

/**
 * «Сотрудники» of A-SUP-03 (SCREENS 7.4; TASK-036): the current employees
 * (the number partly hidden, SCREENS 7.0) with who receives the order
 * notifications and the limit, the invitation, «Назначить контактным
 * лицом», «Отправить приглашение повторно» (its limits are the server's);
 * the removed ones — who removed them and when — with «Восстановить
 * доступ» and its reason; the cabinet sessions with «Завершить». A blocked
 * company adds no employees and sends no invitations (D-070): the button
 * is not offered, and the server refuses anyway.
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
  const sessions = useLoad<AdminSupplierSessionListResponse>(
    () => apiClient.listSupplierSessions({ supplierId: card.id }),
    `sessions:${card.id}`,
  );
  const [adding, setAdding] = useState(false);
  const [restoring, setRestoring] = useState<AdminSupplierMember | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const restoreSaver = useSupplierSaver("supplier_member");
  const blocked = card.state === "blocked";

  const reload = () => {
    members.reload();
    sessions.reload();
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

  const list = members.data?.members ?? [];
  const current = list.filter((member) => member.status === "active");
  const removed = list.filter((member) => member.status === "removed");
  const summary = members.data?.notifications;
  const sessionList = sessions.data?.sessions ?? [];
  const sessionsOf = (memberId: string) =>
    sessionList.filter((session) => session.member.id === memberId).length;

  return (
    <div className="detail-stack">
      <div className="page__tools">
        {blocked ? (
          <Banner tone="warning">
            Компания заблокирована: добавлять сотрудников и отправлять приглашения нельзя, пока
            блокировка не снята. Настройки сотрудников, контактное лицо, восстановление и сессии —
            доступны.
          </Banner>
        ) : (
          <Button icon="plus" disabled={!online} onClick={() => setAdding(true)}>
            Добавить сотрудника
          </Button>
        )}
      </div>
      {problem && <Banner tone="danger">{problem}</Banner>}
      <LoadError error={members.error} retry={members.reload} />
      <LoadingContent
        ready={members.data !== undefined}
        indicator={members.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={4} label="Загрузка" />}
      >
        {summary && (
          <p className="ac-text-body-s">
            Уведомления о заявках получают {summary.recipients} из {summary.limit} возможных
            {summary.full ? ` · достигнут предел — ${summary.limit}` : ""}
            {summary.enabled > summary.recipients
              ? ` · ещё ${summary.enabled - summary.recipients} ждут места (включили позже)`
              : ""}
            . Предел — настройка max_notified_members.
          </p>
        )}
        <section className="card-section">
          <h2 className="ac-text-heading">Сотрудники</h2>
          {current.length === 0 ? (
            <EmptyState icon="users" title="Сотрудников нет" />
          ) : (
            <div className="table-wrap">
              <table className="admin-table members-table">
                <thead>
                  <tr>
                    <th scope="col">Сотрудник</th>
                    <th scope="col">Уведомления</th>
                    <th scope="col">Добавлен</th>
                    <th scope="col">Приглашение</th>
                    <th scope="col" className="admin-table__actions">
                      <span className="ac-visually-hidden">Действия</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {current.map((member) => {
                    const count = sessionsOf(member.id);
                    return (
                      <tr key={member.id}>
                        <td>
                          <div className="cell-stack">
                            <span className="long-text" title={member.displayName}>
                              {member.displayName}
                            </span>
                            <span className="ac-text-caption ac-muted num">
                              {hiddenPhone(member.phone)}
                            </span>
                            {member.isContactPerson && (
                              <span className="ac-text-caption">контактное лицо</span>
                            )}
                          </div>
                        </td>
                        <td className="ac-text-body-s">
                          {member.receivesNotifications
                            ? "получает"
                            : member.notificationsEnabled
                              ? "включены, ждут места"
                              : "выключены"}
                          <span className="ac-text-caption ac-muted">
                            {" "}
                            · {member.notificationLanguage === "kk" ? "kk" : "ru"}
                          </span>
                        </td>
                        <td>
                          <div className="cell-stack">
                            <span className="ac-text-body-s">{addedByText(member)}</span>
                            <span className="ac-text-caption ac-muted">
                              {formatMoment(member.createdAt)}
                            </span>
                            {member.restore && (
                              <span className="ac-text-caption ac-muted">
                                восстановлен {formatMoment(member.restore.at)}:{" "}
                                {member.restore.reason}
                              </span>
                            )}
                          </div>
                        </td>
                        <td>
                          {member.lastInvitation ? (
                            <div className="cell-stack">
                              <span className="ac-text-body-s">
                                {INVITATION_TEXT[member.lastInvitation.status]}
                              </span>
                              <span className="ac-text-caption ac-muted">
                                {formatMoment(
                                  member.lastInvitation.sentAt ?? member.lastInvitation.createdAt,
                                )}
                              </span>
                            </div>
                          ) : (
                            <span className="ac-text-body-s ac-muted">—</span>
                          )}
                        </td>
                        <td className="admin-table__actions">
                          <div className="button-row button-row--end member-actions">
                            {!blocked && (
                              <Button
                                variant="secondary"
                                size="s"
                                disabled={!online}
                                loading={busy === `invite:${member.id}`}
                                onClick={() =>
                                  void act(`invite:${member.id}`, async () => {
                                    await apiClient.resendSupplierInvitation({
                                      supplierId: card.id,
                                      memberId: member.id,
                                    });
                                    return `Приглашение отправлено в WhatsApp: ${member.displayName}`;
                                  })
                                }
                              >
                                Приглашение повторно
                              </Button>
                            )}
                            {!member.isContactPerson && (
                              <Button
                                variant="secondary"
                                size="s"
                                disabled={!online}
                                loading={busy === `contact:${member.id}`}
                                onClick={() =>
                                  void act(`contact:${member.id}`, async () => {
                                    await apiClient.setSupplierContactPerson({
                                      supplierId: card.id,
                                      memberId: member.id,
                                    });
                                    return `Контактное лицо: ${member.displayName}`;
                                  })
                                }
                              >
                                Сделать контактным лицом
                              </Button>
                            )}
                            {count > 0 && (
                              <Button
                                variant="secondary"
                                size="s"
                                disabled={!online}
                                onClick={() =>
                                  setConfirm({ kind: "member-sessions", member, count })
                                }
                              >
                                Завершить все сессии ({count})
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="card-section">
          <h2 className="ac-text-heading">Удалённые</h2>
          {removed.length === 0 ? (
            <p className="ac-text-body-s ac-muted">Удалённых сотрудников нет.</p>
          ) : (
            <div className="table-wrap">
              <table className="admin-table members-table">
                <thead>
                  <tr>
                    <th scope="col">Сотрудник</th>
                    <th scope="col">Удалён</th>
                    <th scope="col">Добавлен</th>
                    <th scope="col" className="admin-table__actions">
                      <span className="ac-visually-hidden">Действия</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {removed.map((member) => (
                    <tr key={member.id} className="row--muted">
                      <td>
                        <div className="cell-stack">
                          <span className="long-text">{member.displayName}</span>
                          <span className="ac-text-caption ac-muted num">
                            {hiddenPhone(member.phone)}
                          </span>
                        </div>
                      </td>
                      <td>
                        <div className="cell-stack">
                          <span className="ac-text-body-s">{formatMoment(member.removedAt)}</span>
                          <span className="ac-text-caption ac-muted">
                            {member.removedByMember
                              ? `удалил(а) ${member.removedByMember.displayName}`
                              : "удалён командой оператора"}
                          </span>
                        </div>
                      </td>
                      <td>
                        <div className="cell-stack">
                          <span className="ac-text-body-s">{addedByText(member)}</span>
                          <span className="ac-text-caption ac-muted">
                            {formatMoment(member.createdAt)}
                          </span>
                        </div>
                      </td>
                      <td className="admin-table__actions">
                        <div className="button-row button-row--end">
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
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </LoadingContent>

      <section className="card-section">
        <h2 className="ac-text-heading">Сессии кабинета</h2>
        <LoadError error={sessions.error} retry={sessions.reload} />
        <LoadingContent
          ready={sessions.data !== undefined}
          indicator={sessions.indicator}
          label="Загрузка"
          skeleton={<SkeletonList rows={2} label="Загрузка" />}
        >
          {sessionList.length === 0 ? (
            <p className="ac-text-body-s ac-muted">
              Сейчас никто из сотрудников не вошёл в кабинет.
            </p>
          ) : (
            <div className="table-wrap">
              <table className="admin-table sessions-table">
                <thead>
                  <tr>
                    <th scope="col">Сотрудник</th>
                    <th scope="col">Устройство</th>
                    <th scope="col">Вход</th>
                    <th scope="col">Последний раз</th>
                    <th scope="col">Истекает</th>
                    <th scope="col" className="admin-table__actions">
                      <span className="ac-visually-hidden">Действия</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sessionList.map((session) => (
                    <tr key={session.id}>
                      <td className="long-text">{session.member.displayName}</td>
                      <td>
                        <div className="cell-stack">
                          <span className="ac-text-body-s">
                            {session.deviceName ?? "Устройство не названо"}
                          </span>
                          <span className="ac-text-caption ac-muted">
                            {[session.platform, session.clientVersion, session.ipHint]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        </div>
                      </td>
                      <td className="ac-text-body-s num">{formatMoment(session.createdAt)}</td>
                      <td className="ac-text-body-s num">{formatMoment(session.lastUsedAt)}</td>
                      <td className="ac-text-body-s num">{formatMoment(session.expiresAt)}</td>
                      <td className="admin-table__actions">
                        <div className="button-row button-row--end">
                          <Button
                            variant="secondary"
                            size="s"
                            disabled={!online}
                            onClick={() => setConfirm({ kind: "session", session })}
                          >
                            Завершить
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </LoadingContent>
      </section>

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
        error={<FormError saver={restoreSaver} onRefresh={reload} />}
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
        <FormError saver={saver} fields={["name", "phone"]} />
      </div>
    </Dialog>
  );
}
