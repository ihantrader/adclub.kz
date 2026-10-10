import type {
  AdminDisciplineMark,
  AdminDisciplinePage,
  AdminOrderSummary,
  AdminUser,
  AdminUserGarageResponse,
  AdminUserResponse,
  AdminUserSession,
  AdminUserSessionListResponse,
  ClubAccessGrantPage,
} from "@adclub/contracts";
import {
  Banner,
  Button,
  Dialog,
  EmptyState,
  IconButton,
  LoadingContent,
  SkeletonList,
  useToast,
} from "@adclub/ui";
import { formatKzPlate } from "@adclub/domain";
import { useOnline } from "@adclub/web-session";
import { useState, type ReactNode } from "react";
import { apiClient } from "../api";
import { JournalHistory } from "../audit/JournalHistory";
import { AppLink, follow } from "../catalog/shared";
import { formatMoment } from "../format";
import { Discipline } from "../orders/OrderCard";
import { OrdersTable } from "../orders/Orders";
import { orderErrorText } from "../orders/order-words";
import { PhoneReveal } from "../people/PhoneReveal";
import { useAdminNames } from "../people/use-admin-names";
import { goBack, supplierPath, useLocation, userPath, type UserTab } from "../router";
import { ReasonDialog, WasNow } from "../suppliers/shared";
import { useLoad } from "../use-load";
import { LoadError, MoreButton, usePaged } from "../vehicles/shared";
import { UsersTabs } from "./Users";
import {
  accessText,
  carDocumentText,
  carText,
  lastDayText,
  deviceText,
  endOfYear,
  GRANT_STATUS_TEXT,
  grantUntil,
  LANGUAGE_TEXT,
  userErrorText,
} from "./user-words";

const TAB_TEXT: Record<UserTab, string> = {
  profile: "Профиль",
  access: "Клубный доступ",
  garage: "Гараж",
  orders: "Заявки",
  discipline: "Дисциплина",
  sessions: "Сессии",
  history: "История",
};

const TABS = Object.keys(TAB_TEXT) as UserTab[];

/**
 * A-USR-02 «Карточка пользователя» (SCREENS 7.6; TASK-036.B): the tabs in
 * the address. The profile with its consents and dates (the number partly
 * hidden, «Показать номер» with a trace), club access with its history and
 * «Выдать доступ…» / «Отозвать…» (the existing grants of `ClubAccessGrants`,
 * by the account), the garage to look at, the orders to their cards, the
 * no-shows with «Снять…», the sessions of the app with «Завершить» and
 * «Завершить все сессии», the history from the journal. A user who also
 * works for a supplier is marked «Сотрудник поставщика: {компания}».
 */
export function UserCard({ accountId }: { accountId: string }) {
  const { query } = useLocation();
  const card = useLoad<AdminUserResponse>(
    () => apiClient.getAdminUser({ accountId }),
    `user:${accountId}`,
  );
  const user = card.data && card.data.user.accountId === accountId ? card.data.user : undefined;
  const asked = (query.get("tab") ?? "profile") as UserTab;
  const tab: UserTab = TABS.includes(asked) ? asked : "profile";

  let body: ReactNode = null;
  if (user) {
    switch (tab) {
      case "profile":
        body = <Profile user={user} />;
        break;
      case "access":
        body = <Access user={user} onChanged={card.reload} />;
        break;
      case "garage":
        body = <Garage accountId={accountId} />;
        break;
      case "orders":
        body = <UserOrders accountId={accountId} />;
        break;
      case "discipline":
        body = <UserDiscipline accountId={accountId} onChanged={card.reload} />;
        break;
      case "sessions":
        body = <Sessions accountId={accountId} onChanged={card.reload} />;
        break;
      case "history":
        body = (
          <JournalHistory
            filter={{ accountId }}
            loadKey={`user-history:${accountId}`}
            caption="История пользователя"
          />
        );
        break;
    }
  }

  return (
    <>
      <div className="page__head page__head--back">
        <IconButton
          icon="arrowLeft"
          label="Назад к пользователям"
          onClick={() => goBack("users")}
        />
        <div className="cell-stack supplier-head">
          <h1 className="ac-text-title-l page__title long-text">
            {user ? (user.name ?? "Без имени") : "Пользователь"}
          </h1>
          {user && (
            <span className="ac-text-body-s ac-muted supplier-head__line">
              <span className="num">{user.phone}</span>
              <span>клубный доступ: {accessText(user.clubAccess)}</span>
              {user.memberships
                .filter((membership) => membership.status === "active")
                .map((membership) => (
                  <span key={membership.memberId}>
                    Сотрудник поставщика:{" "}
                    <AppLink href={supplierPath(membership.supplierId, "members")}>
                      {membership.supplierName}
                    </AppLink>
                  </span>
                ))}
            </span>
          )}
        </div>
        <Button variant="secondary" size="s" icon="refresh" onClick={card.reload}>
          Обновить
        </Button>
      </div>
      <UsersTabs active={null} />
      <LoadError error={card.error} retry={card.reload} />
      <LoadingContent
        ready={user !== undefined}
        indicator={card.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={6} label="Загрузка" />}
      >
        {user && (
          <nav className="page-tabs" aria-label="Карточка пользователя">
            {TABS.map((entry) => {
              const href = userPath(accountId, entry);
              const count = countOf(user, entry);
              return (
                <a
                  key={entry}
                  href={href}
                  className={entry === tab ? "page-tabs__tab page-tabs__tab--on" : "page-tabs__tab"}
                  aria-current={entry === tab ? "page" : undefined}
                  onClick={(event) => follow(event, href)}
                >
                  {TAB_TEXT[entry]}
                  {count !== null && <span className="funnel-tab__count"> · {count}</span>}
                </a>
              );
            })}
          </nav>
        )}
        <div className="tab-body">{body}</div>
      </LoadingContent>
    </>
  );
}

function countOf(user: AdminUser, tab: UserTab): number | null {
  switch (tab) {
    case "garage":
      return user.counts.cars;
    case "orders":
      return user.counts.orders;
    case "discipline":
      return user.counts.noShows;
    case "sessions":
      return user.counts.sessions;
    default:
      return null;
  }
}

function Profile({ user }: { user: AdminUser }) {
  return (
    <section className="card-section">
      {!user.registrationCompleted && (
        <Banner tone="warning">
          Регистрация не завершена: нет имени или согласия — оформить заявку пользователь не может.
        </Banner>
      )}
      <dl className="facts">
        <div>
          <dt>Имя</dt>
          <dd className="long-text">{user.name ?? <span className="ac-muted">не указано</span>}</dd>
        </div>
        <div>
          <dt>Телефон</dt>
          <dd>
            <PhoneReveal phone={user.phone} subject="account" id={user.accountId} />
          </dd>
        </div>
        <div>
          <dt>E-mail</dt>
          <dd className="long-text">
            {user.email ?? <span className="ac-muted">не указан</span>}
            {user.email && (
              <span className="ac-text-caption ac-muted">
                {user.emailNewsConsent ? " · новости клуба — да" : " · новости клуба — нет"}
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt>Город</dt>
          <dd>{user.city?.name ?? <span className="ac-muted">весь Казахстан</span>}</dd>
        </div>
        <div>
          <dt>Язык</dt>
          <dd>
            {user.language ? LANGUAGE_TEXT[user.language] : <span className="ac-muted">—</span>}
          </dd>
        </div>
        <div>
          <dt>Появился</dt>
          <dd className="num">{formatMoment(user.createdAt)}</dd>
        </div>
        <div>
          <dt>Согласие на передачу номера поставщику</dt>
          <dd className="num">
            {user.phoneShareConsent
              ? `${formatMoment(user.phoneShareConsent.at)}, текст ${user.phoneShareConsent.version}`
              : "не давал"}
          </dd>
        </div>
      </dl>
      {user.memberships.length > 0 && (
        <div className="cell-stack">
          <span className="ac-text-body-strong">Работа у поставщиков</span>
          <ul className="plain-list">
            {user.memberships.map((membership) => (
              <li key={membership.memberId} className="ac-text-body-s">
                Сотрудник поставщика:{" "}
                <AppLink href={supplierPath(membership.supplierId, "members")}>
                  {membership.supplierName}
                </AppLink>{" "}
                — {membership.displayName}
                {membership.status === "removed" ? " (удалён)" : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** Club access now, its history, «Выдать доступ…» and «Отозвать…» (the existing grants, by the account). */
function Access({ user, onChanged }: { user: AdminUser; onChanged: () => void }) {
  const toast = useToast();
  const online = useOnline();
  const admins = useAdminNames();
  const [historyKey, setHistoryKey] = useState(0);
  const grants = useLoad<ClubAccessGrantPage>(
    () =>
      apiClient.listClubAccessGrants({
        query: { status: "all", accountId: user.accountId, limit: 100 },
      }),
    `grants:${user.accountId}:${historyKey}`,
  );
  const [asking, setAsking] = useState<"grant" | "revoke" | null>(null);
  const [until, setUntil] = useState(endOfYear());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const access = user.clubAccess;

  const grant = async (reason: string) => {
    const validUntil = grantUntil(until);
    if (!validUntil) {
      setError("Укажите дату окончания");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiClient.grantClubAccess({ accountId: user.accountId, validUntil, reason });
      setAsking(null);
      setHistoryKey((key) => key + 1);
      onChanged();
      toast.show(`Клубный доступ выдан до ${lastDayText(validUntil)}`);
    } catch (thrown) {
      setError(userErrorText(thrown));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (reason: string) => {
    setBusy(true);
    setError(null);
    try {
      await apiClient.revokeClubAccess({ accountId: user.accountId, reason });
      setAsking(null);
      setHistoryKey((key) => key + 1);
      onChanged();
      toast.show("Клубный доступ отозван");
    } catch (thrown) {
      setError(userErrorText(thrown));
    } finally {
      setBusy(false);
    }
  };

  const who = (actor: { role: "admin" | "operator"; adminId: string | null } | null) =>
    !actor
      ? ""
      : actor.role === "operator"
        ? "оператор сервера"
        : ((actor.adminId && admins.get(actor.adminId)) ?? "администратор");

  return (
    <div className="detail-stack">
      <p className="ac-text-body">
        Сейчас: <strong>{access.granted ? `есть, ${accessText(access)}` : "нет"}</strong>
        <span className="ac-text-caption ac-muted">
          {" "}
          (подписок пока нет — доступ выдаётся вручную)
        </span>
      </p>
      <div className="button-row">
        <Button
          disabled={!online}
          onClick={() => {
            setError(null);
            setAsking("grant");
          }}
        >
          Выдать доступ…
        </Button>
        {access.granted && (
          <Button
            variant="secondary"
            disabled={!online}
            onClick={() => {
              setError(null);
              setAsking("revoke");
            }}
          >
            Отозвать…
          </Button>
        )}
      </div>
      <LoadError error={grants.error} retry={grants.reload} />
      <LoadingContent
        ready={grants.data !== undefined}
        indicator={grants.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={3} label="Загрузка" />}
      >
        {(grants.data?.grants.length ?? 0) === 0 ? (
          <EmptyState icon="lock" title="Выдач клубного доступа не было" />
        ) : (
          <div className="table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th scope="col">Выдача</th>
                  <th scope="col">До</th>
                  <th scope="col">Причина</th>
                  <th scope="col">Конец</th>
                </tr>
              </thead>
              <tbody>
                {grants.data?.grants.map((grant) => (
                  <tr key={grant.id}>
                    <td className="ac-text-body-s">
                      <div className="cell-stack">
                        <span>{GRANT_STATUS_TEXT[grant.status]}</span>
                        <span className="ac-text-caption ac-muted">
                          {formatMoment(grant.grantedAt)}, {who(grant.grantedBy)}
                        </span>
                      </div>
                    </td>
                    <td className="num">{lastDayText(grant.validUntil)}</td>
                    <td className="ac-text-body-s reason-cell">{grant.reason}</td>
                    <td className="ac-text-body-s reason-cell">
                      {grant.revokedAt ? (
                        <>
                          {formatMoment(grant.revokedAt)}, {who(grant.revokedBy)}
                          {grant.status === "revoked" && grant.revokeReason
                            ? `: ${grant.revokeReason}`
                            : ""}
                        </>
                      ) : (
                        <span className="ac-muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </LoadingContent>
      <ReasonDialog
        open={asking === "grant"}
        title="Выдать клубный доступ"
        confirm="Выдать"
        onConfirm={grant}
        onClose={() => setAsking(null)}
        busy={busy}
        error={error && <p className="dialog-error">{error}</p>}
      >
        <label className="select">
          <span className="ac-text-caption ac-muted">
            До какого числа (включительно, время Алматы)
          </span>
          <input type="date" value={until} onChange={(event) => setUntil(event.target.value)} />
        </label>
        <WasNow
          was={access.granted ? `доступ ${accessText(access)}` : "доступа нет"}
          now={grantUntil(until) ? `доступ до ${lastDayText(grantUntil(until)!)}` : "—"}
        />
        {access.granted && (
          <p className="ac-text-body-s">
            Действующая выдача {accessText(access)} будет заменена новой — в истории останутся обе.
          </p>
        )}
      </ReasonDialog>
      <ReasonDialog
        open={asking === "revoke"}
        title="Отозвать клубный доступ"
        confirm="Отозвать"
        onConfirm={revoke}
        onClose={() => setAsking(null)}
        busy={busy}
        error={error && <p className="dialog-error">{error}</p>}
      >
        <WasNow was={`доступ ${accessText(access)}`} now="доступа нет" />
        <p className="ac-text-body-s">
          Со следующего запроса пользователь перестанет видеть названия поставщиков и не сможет
          оформлять заявки. Уже оформленные заявки и их коды остаются.
        </p>
      </ReasonDialog>
    </div>
  );
}

function Garage({ accountId }: { accountId: string }) {
  const garage = useLoad<AdminUserGarageResponse>(
    () => apiClient.getAdminUserGarage({ accountId }),
    `garage:${accountId}`,
  );
  return (
    <div className="detail-stack">
      <LoadError error={garage.error} retry={garage.reload} />
      <LoadingContent
        ready={garage.data !== undefined}
        indicator={garage.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={3} label="Загрузка" />}
      >
        {(garage.data?.cars.length ?? 0) === 0 ? (
          <EmptyState icon="car" title="В гараже нет автомобилей" />
        ) : (
          <ul className="plain-list">
            {garage.data?.cars.map((car) => (
              <li key={car.id} className="ac-text-body-s">
                {carText(car)}
                {car.isPrimary && <span className="status status--acknowledged"> основной</span>}
                <span className="ac-text-caption ac-muted">
                  {" "}
                  · добавлен {formatMoment(car.createdAt)}
                </span>
                {/* TASK-057 (D-064): VIN, plate and the mark of the document. */}
                <div className="ac-text-caption">
                  VIN: {car.vin ?? "не указан"} · Госномер:{" "}
                  {car.plate ? formatKzPlate(car.plate) : "не указан"} ·{" "}
                  <span
                    className={
                      car.document?.status === "shown"
                        ? "status status--acknowledged"
                        : "status status--open"
                    }
                  >
                    {carDocumentText(car.document, formatMoment)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </LoadingContent>
    </div>
  );
}

function UserOrders({ accountId }: { accountId: string }) {
  const list = usePaged<AdminOrderSummary>(async (cursor) => {
    const page = await apiClient.listAdminOrders({
      query: { accountId, test: "include", limit: 50, cursor },
    });
    return { items: page.orders, total: page.total, nextCursor: page.nextCursor };
  }, `user-orders:${accountId}`);
  return (
    <div className="detail-stack">
      <LoadError error={list.first.error} retry={list.first.reload} />
      <LoadingContent
        ready={list.first.data !== undefined}
        indicator={list.first.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={4} label="Загрузка" />}
      >
        <p className="ac-text-body-s ac-muted">Всего: {list.total.toLocaleString("ru-RU")}</p>
        {list.items.length === 0 ? (
          <EmptyState icon="receipt" title="Заявок пока нет" />
        ) : (
          <OrdersTable orders={list.items} hide={["customer"]} />
        )}
        <MoreButton list={list} />
      </LoadingContent>
    </div>
  );
}

function UserDiscipline({ accountId, onChanged }: { accountId: string; onChanged: () => void }) {
  const toast = useToast();
  const admins = useAdminNames();
  const [key, setKey] = useState(0);
  const marks = useLoad<AdminDisciplinePage>(
    () => apiClient.listAdminDiscipline({ query: { accountId, state: "all", limit: 100 } }),
    `marks:${accountId}:${key}`,
  );
  const [mark, setMark] = useState<AdminDisciplineMark | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revoke = async (reason: string) => {
    if (!mark) return;
    setBusy(true);
    setError(null);
    try {
      await apiClient.revokeAdminDiscipline({ markId: mark.id }, { reason });
      setMark(null);
      setKey((value) => value + 1);
      onChanged();
      toast.show("Дисциплинарная отметка снята");
    } catch (thrown) {
      setError(orderErrorText(thrown, admins));
    } finally {
      setBusy(false);
    }
  };
  const list = marks.data?.marks ?? [];
  return (
    <div className="detail-stack">
      <p className="ac-text-body-s ac-muted">
        Неявки видны только администраторам: пользователю и поставщику они не показываются.
      </p>
      <LoadError error={marks.error} retry={marks.reload} />
      <LoadingContent
        ready={marks.data !== undefined}
        indicator={marks.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={3} label="Загрузка" />}
      >
        {list.length === 0 ? (
          <EmptyState icon="circleCheck" title="Неявок не было" />
        ) : (
          <Discipline
            marks={list}
            admins={admins}
            showOrder
            onRevoke={(next) => {
              setError(null);
              setMark(list.find((entry) => entry.id === next.id) ?? null);
            }}
          />
        )}
      </LoadingContent>
      <ReasonDialog
        open={mark !== null}
        title="Снять дисциплинарную отметку"
        confirm="Снять отметку"
        onConfirm={revoke}
        onClose={() => setMark(null)}
        busy={busy}
        error={error && <p className="dialog-error">{error}</p>}
      >
        <WasNow was="Неявка учитывается" now="Неявка снята (остаётся в истории)" />
      </ReasonDialog>
    </div>
  );
}

function Sessions({ accountId, onChanged }: { accountId: string; onChanged: () => void }) {
  const toast = useToast();
  const online = useOnline();
  const [key, setKey] = useState(0);
  const sessions = useLoad<AdminUserSessionListResponse>(
    () => apiClient.listAdminUserSessions({ accountId }),
    `sessions:${accountId}:${key}`,
  );
  const [ending, setEnding] = useState<AdminUserSession | "all" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = sessions.data?.sessions ?? [];

  const end = async () => {
    if (!ending) return;
    setBusy(true);
    setError(null);
    try {
      const answer =
        ending === "all"
          ? await apiClient.endAdminUserSessions({ accountId })
          : await apiClient.endAdminUserSession({ accountId, sessionId: ending.id });
      setEnding(null);
      setKey((value) => value + 1);
      onChanged();
      toast.show(`Завершено сессий: ${answer.ended}`);
    } catch (thrown) {
      setError(userErrorText(thrown));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="detail-stack">
      <p className="ac-text-body-s ac-muted">
        Сессии приложения. Кабинет поставщика и админка этого же человека здесь не завершаются.
      </p>
      {list.length > 0 && (
        <div className="button-row">
          <Button
            variant="secondary"
            disabled={!online}
            onClick={() => {
              setError(null);
              setEnding("all");
            }}
          >
            Завершить все сессии ({list.length})
          </Button>
        </div>
      )}
      <LoadError error={sessions.error} retry={sessions.reload} />
      <LoadingContent
        ready={sessions.data !== undefined}
        indicator={sessions.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={3} label="Загрузка" />}
      >
        {list.length === 0 ? (
          <EmptyState icon="lock" title="Активных сессий нет" />
        ) : (
          <div className="table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th scope="col">Устройство</th>
                  <th scope="col">Вход</th>
                  <th scope="col">Последнее обращение</th>
                  <th scope="col">
                    <span className="ac-visually-hidden">Действия</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.map((session) => (
                  <tr key={session.id}>
                    <td className="ac-text-body-s">
                      {deviceText(session)}
                      {session.ipHint && <span className="ac-muted"> · {session.ipHint}</span>}
                    </td>
                    <td className="ac-text-body-s num">{formatMoment(session.createdAt)}</td>
                    <td className="ac-text-body-s num">{formatMoment(session.lastUsedAt)}</td>
                    <td className="admin-table__actions">
                      <Button
                        variant="text"
                        size="s"
                        disabled={!online}
                        onClick={() => {
                          setError(null);
                          setEnding(session);
                        }}
                      >
                        Завершить
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </LoadingContent>
      <Dialog
        open={ending !== null}
        onClose={() => setEnding(null)}
        title={ending === "all" ? "Завершить все сессии приложения?" : "Завершить сессию?"}
        actions={
          <>
            <Button onClick={end} loading={busy}>
              Завершить
            </Button>
            <Button variant="secondary" onClick={() => setEnding(null)}>
              Отмена
            </Button>
          </>
        }
      >
        <div className="dialog-stack">
          <p>
            {ending === "all"
              ? "Приложение на всех устройствах пользователя выйдет из аккаунта при следующем обращении к серверу. Войти снова можно по коду."
              : ending
                ? `${deviceText(ending)}: приложение выйдет из аккаунта при следующем обращении к серверу.`
                : ""}
          </p>
          {error && <p className="dialog-error">{error}</p>}
        </div>
      </Dialog>
    </div>
  );
}
