import type {
  AdminDisciplineMark,
  AdminDisciplinePage,
  AdminOrderSummary,
  AdminUser,
  AdminUserGarageResponse,
  AdminUserResponse,
  AdminUserSession,
  AdminUserSessionListResponse,
  AdminUserSubscriptionResponse,
  ClubAccessGrantPage,
} from "@adclub/contracts";
import {
  Badge,
  Banner,
  Button,
  DateField,
  Dialog,
  EmptyState,
  IconButton,
  LoadingContent,
  SkeletonList,
  StatusBadge,
  TableToolbar,
  useToast,
} from "@adclub/ui";
import { formatKzPlate } from "@adclub/domain";
import { useOnline } from "@adclub/web-session";
import { useState, type ReactNode } from "react";
import { apiClient } from "../api";
import { JournalHistory } from "../audit/JournalHistory";
import { formatMoment } from "../format";
import { AppLink, Header, Table } from "../layout/layout";
import { Discipline } from "../orders/OrderCard";
import { MoreOrders, OrdersTable } from "../orders/Orders";
import { orderErrorText } from "../orders/order-words";
import { PhoneReveal } from "../people/PhoneReveal";
import { useAdminNames } from "../people/use-admin-names";
import { ComplaintRows, useComplaintList } from "../reviews/Complaints";
import { supplierPath, useLocation, userPath, type UserTab } from "../router";
import { ReasonDialog, WasNow } from "../suppliers/shared";
import { useLoad } from "../use-load";
import { LoadError, usePaged } from "../vehicles/shared";
import {
  accessSourceText,
  outcomeText,
  SUBSCRIPTION_BY_TEXT,
  SUBSCRIPTION_EVENT_TEXT,
  SUBSCRIPTION_PROVIDER_TEXT,
  SUBSCRIPTION_STATUS_TEXT,
} from "./subscription-words";
import { AccessMark, USERS_CRUMB } from "./Users";
import {
  accessText,
  carDocumentText,
  carParams,
  carTitle,
  consentText,
  deviceText,
  endOfYear,
  GRANT_STATUS_TEXT,
  grantUntil,
  ipText,
  LANGUAGE_TEXT,
  lastDayText,
  userErrorText,
} from "./user-words";
import "./users.css";

const TAB_TEXT: Record<UserTab, string> = {
  profile: "Профиль",
  access: "Клубный доступ",
  garage: "Гараж",
  orders: "Заявки",
  discipline: "Дисциплина",
  complaints: "Жалобы",
  sessions: "Сессии",
  history: "История",
};

const TABS = Object.keys(TAB_TEXT) as UserTab[];

/** Sessions shown before «Показать все (N)» (X22). */
const SESSIONS_SHOWN = 10;

/**
 * A-USR-02 «Карточка пользователя» (SCREENS 7.6; TASK-036.B, TASK-080): the
 * crumbs of «Пользователи», the name (or the number, partly hidden), club
 * access as a mark and the employments under it; one bar of the card's tabs
 * with their counts, in the address. The profile with its consents and dates
 * (the number partly hidden, «Показать номер» with a trace), club access —
 * the subscription and the grants by hand with «Выдать доступ…» /
 * «Отозвать…», the garage to look at, the orders to their cards, the
 * no-shows with «Снять…», the complaints, the sessions of the app with
 * «Завершить» and «Завершить все сессии», the history from the journal.
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
      case "complaints":
        body = <UserComplaints accountId={accountId} />;
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

  const employments = user?.memberships.filter((membership) => membership.status === "active");

  return (
    <>
      <Header<UserTab>
        crumbs={[USERS_CRUMB]}
        title={user ? (user.name ?? user.phone) : "Пользователь"}
        subtitle={
          user && (
            <>
              <AccessMark state={user.clubAccess} />
              {user.name && <span className="nowrap">{user.phone}</span>}
              {employments?.map((membership) => (
                <span key={membership.memberId}>
                  Сотрудник поставщика:{" "}
                  <AppLink href={supplierPath(membership.supplierId, "members")}>
                    {membership.supplierName}
                  </AppLink>
                </span>
              ))}
            </>
          )
        }
        actions={<IconButton icon="refresh" label="Обновить" size={20} onClick={card.reload} />}
        tabs={
          user
            ? {
                label: "Карточка пользователя",
                active: tab,
                items: TABS.map((entry) => ({
                  key: entry,
                  label: TAB_TEXT[entry],
                  href: userPath(accountId, entry),
                  count: countOf(user, entry),
                })),
              }
            : undefined
        }
      />
      <LoadError error={card.error} retry={card.reload} />
      <LoadingContent
        ready={user !== undefined}
        indicator={card.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={6} label="Загрузка" />}
      >
        <div className="tab-body">{body}</div>
      </LoadingContent>
    </>
  );
}

/**
 * The counts of the tabs the card knows (A-USR-02): the cars, the orders,
 * the no-shows that stand, the sessions. Club access, the complaints and the
 * history have none — the user's card does not count them.
 */
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

function Muted({ children }: { children: ReactNode }) {
  return <span className="ac-muted">{children}</span>;
}

/** The profile: a card up to 720, «подпись — значение» in two columns. */
function Profile({ user }: { user: AdminUser }) {
  return (
    <div className="user-tab">
      {!user.registrationCompleted && (
        <Banner tone="warning">
          Регистрация не завершена: нет имени или согласия — оформить заявку пользователь не может.
        </Banner>
      )}
      <section className="card user-profile" aria-label="Профиль">
        <dl className="kv">
          <dt>Имя</dt>
          <dd>{user.name ?? <Muted>не указано</Muted>}</dd>
          <dt>Телефон</dt>
          <dd>
            <PhoneReveal phone={user.phone} subject="account" id={user.accountId} />
          </dd>
          <dt>E-mail</dt>
          <dd>
            {user.email ?? <Muted>не указан</Muted>}
            {user.email && (
              <span className="kv__note">
                {user.emailNewsConsent ? "Новости клуба — получает" : "Новости клуба — не получает"}
              </span>
            )}
          </dd>
          <dt>Город</dt>
          <dd>{user.city?.name ?? <Muted>весь Казахстан</Muted>}</dd>
          <dt>Язык</dt>
          <dd>{user.language ? LANGUAGE_TEXT[user.language] : <Muted>—</Muted>}</dd>
          <dt>Появился</dt>
          <dd>{formatMoment(user.createdAt)}</dd>
          <dt>Согласие на передачу номера</dt>
          <dd>
            {user.phoneShareConsent ? (
              consentText(user.phoneShareConsent, (iso) => formatMoment(iso))
            ) : (
              <Muted>не давал</Muted>
            )}
          </dd>
          {user.memberships.length > 0 && (
            <>
              <dt>Работа у поставщиков</dt>
              <dd>
                <ul className="plain-list user-memberships">
                  {user.memberships.map((membership) => (
                    <li key={membership.memberId}>
                      <AppLink href={supplierPath(membership.supplierId, "members")}>
                        {membership.supplierName}
                      </AppLink>{" "}
                      <Muted>
                        — {membership.displayName}
                        {membership.status === "removed" ? " (удалён)" : ""}
                      </Muted>
                    </li>
                  ))}
                </ul>
              </dd>
            </>
          )}
        </dl>
      </section>
    </div>
  );
}

/**
 * Club access: its state in the head of the tab, then two sections 32
 * apart — the subscription (the stores', read only) and the grants by hand
 * with «Выдать доступ…» / «Отозвать…» (the existing grants, by the account).
 */
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
  const paid = useLoad<AdminUserSubscriptionResponse>(
    () => apiClient.getAdminUserSubscription({ accountId: user.accountId }),
    `subscription:${user.accountId}:${historyKey}`,
  );
  const [asking, setAsking] = useState<"grant" | "revoke" | null>(null);
  const [until, setUntil] = useState(endOfYear());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const access = paid.data?.access ?? user.clubAccess;
  const source = accessSourceText(access);
  // «Отозвать…» ends the grant by hand only; a subscription is the store's.
  const manual = paid.data
    ? paid.data.manualGrant
    : access.source === "manual" && access.validUntil
      ? { validUntil: access.validUntil }
      : null;
  const list = grants.data?.grants ?? [];

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

  const grantButton = (
    <Button
      variant="secondary"
      size="s"
      icon="plus"
      disabled={!online}
      onClick={() => {
        setError(null);
        setAsking("grant");
      }}
    >
      Выдать доступ…
    </Button>
  );

  return (
    <div className="user-tab">
      <div className="user-access-now">
        <span className="ac-text-body-s ac-muted">Сейчас</span>
        <AccessMark state={access} />
        {source && <span className="ac-text-body-s ac-muted">{source}</span>}
      </div>
      <Subscription
        data={paid.data}
        error={paid.error}
        retry={paid.reload}
        indicator={paid.indicator}
      />
      <section className="section" aria-labelledby="user-grants-title">
        <div className="section__head">
          <h2 className="section__title" id="user-grants-title">
            Выдача вручную
          </h2>
          {(list.length > 0 || manual) && (
            <span className="button-row">
              {manual && (
                <Button
                  variant="secondary"
                  size="s"
                  destructive
                  disabled={!online}
                  onClick={() => {
                    setError(null);
                    setAsking("revoke");
                  }}
                >
                  Отозвать…
                </Button>
              )}
              {grantButton}
            </span>
          )}
        </div>
        {manual && <p className="section__note">Действует до {lastDayText(manual.validUntil)}</p>}
        <LoadError error={grants.error} retry={grants.reload} />
        <LoadingContent
          ready={grants.data !== undefined}
          indicator={grants.indicator}
          label="Загрузка"
          skeleton={<SkeletonList rows={3} label="Загрузка" />}
        >
          {list.length === 0 ? (
            <div className="user-none">
              <span className="ac-text-body-s ac-muted">Выдач не было</span>
              {grantButton}
            </div>
          ) : (
            <Table
              label="Выдачи клубного доступа"
              columns={[
                { key: "grant", header: "Выдача", width: 260 },
                { key: "until", header: "До", width: 120 },
                { key: "reason", header: "Причина" },
                { key: "end", header: "Конец", width: 260 },
              ]}
            >
              {list.map((entry) => (
                <tr key={entry.id}>
                  <td>
                    <span className="cell-stack">
                      <StatusBadge kind="clubAccessGrant" status={entry.status}>
                        {capitalized(GRANT_STATUS_TEXT[entry.status])}
                      </StatusBadge>
                      <span className="ac-text-caption ac-muted">
                        {formatMoment(entry.grantedAt)}, {who(entry.grantedBy)}
                      </span>
                    </span>
                  </td>
                  <td className="ac-text-body-s nowrap">{lastDayText(entry.validUntil)}</td>
                  <td className="ac-text-body-s">{entry.reason}</td>
                  <td className="ac-text-body-s">
                    {entry.revokedAt ? (
                      <span className="cell-stack">
                        <span>
                          {formatMoment(entry.revokedAt)}, {who(entry.revokedBy)}
                        </span>
                        {entry.status === "revoked" && entry.revokeReason && (
                          <span className="ac-text-caption ac-muted">{entry.revokeReason}</span>
                        )}
                      </span>
                    ) : (
                      <Muted>—</Muted>
                    )}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </LoadingContent>
      </section>
      <ReasonDialog
        open={asking === "grant"}
        title="Выдать клубный доступ"
        confirm="Выдать"
        onConfirm={grant}
        onClose={() => setAsking(null)}
        busy={busy}
        error={error && <p className="dialog-error">{error}</p>}
      >
        <DateField
          label="До какого числа (включительно, время Алматы)"
          value={until}
          locale="ru"
          onChange={setUntil}
        />
        <WasNow
          was={access.granted ? `доступ ${accessText(access)}` : "доступа нет"}
          now={grantUntil(until) ? `доступ до ${lastDayText(grantUntil(until) ?? "")}` : "—"}
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

function capitalized(text: string): string {
  return text.charAt(0).toLocaleUpperCase("ru-RU") + text.slice(1);
}

/**
 * The subscription of A-USR-02 «Клубный доступ» (TASK-040): its status as a
 * badge, until when, the provider, and the history of its events — the
 * server's, read only (the stores manage it; the billing screens — TASK-043).
 */
function Subscription({
  data,
  error,
  retry,
  indicator,
}: {
  data: AdminUserSubscriptionResponse | undefined;
  error: unknown;
  retry: () => void;
  indicator: boolean;
}) {
  const subscription = data?.subscription ?? null;
  return (
    <section className="section" aria-labelledby="user-subscription-title">
      <div className="section__head">
        <h2 className="section__title" id="user-subscription-title">
          Подписка
        </h2>
      </div>
      <LoadError error={error} retry={retry} />
      <LoadingContent
        ready={data !== undefined}
        indicator={indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={2} label="Загрузка" />}
      >
        <div className="section">
          {!subscription ? (
            <p className="ac-text-body-s ac-muted">Подписки не было</p>
          ) : (
            <div className="card user-subscription">
              <dl className="kv">
                <dt>Статус</dt>
                <dd className="badges">
                  <StatusBadge kind="subscription" status={subscription.status}>
                    {SUBSCRIPTION_STATUS_TEXT[subscription.status]}
                  </StatusBadge>
                  <Muted>{subscription.grantsAccess ? "даёт доступ" : "доступа не даёт"}</Muted>
                </dd>
                <dt>Оплачено до</dt>
                <dd>{formatMoment(subscription.periodEnd)}</dd>
                {subscription.graceUntil && (
                  <>
                    <dt>Льготный период до</dt>
                    <dd>{formatMoment(subscription.graceUntil)}</dd>
                  </>
                )}
                {subscription.accessUntil && (
                  <>
                    <dt>Доступ до</dt>
                    <dd>
                      {formatMoment(subscription.accessUntil)}
                      {!subscription.statusConfirmed && (
                        <span className="kv__note">ждём подтверждения стора</span>
                      )}
                    </dd>
                  </>
                )}
                <dt>Провайдер</dt>
                <dd>
                  {SUBSCRIPTION_PROVIDER_TEXT[subscription.provider]}
                  {subscription.platform &&
                    ` · ${subscription.platform === "ios" ? "iOS" : "Android"}`}
                </dd>
              </dl>
            </div>
          )}
          {(data?.history.length ?? 0) > 0 && (
            <Table
              label="События подписки"
              columns={[
                { key: "event", header: "Событие" },
                { key: "at", header: "Когда", width: 140 },
                { key: "status", header: "Статус", width: 280 },
                { key: "outcome", header: "Итог", width: 260 },
              ]}
            >
              {data?.history.map((entry) => (
                <tr key={entry.id}>
                  <td className="ac-text-body-s">
                    <span className="cell-stack">
                      <span>{SUBSCRIPTION_EVENT_TEXT[entry.kind] ?? entry.kind}</span>
                      <span className="ac-text-caption ac-muted">
                        {SUBSCRIPTION_BY_TEXT[entry.by]}
                        {entry.periodEnd && `, до ${formatMoment(entry.periodEnd)}`}
                      </span>
                    </span>
                  </td>
                  <td className="ac-text-body-s nowrap">{formatMoment(entry.eventAt)}</td>
                  <td className="ac-text-body-s">
                    {entry.toStatus && entry.fromStatus !== entry.toStatus ? (
                      <>
                        {entry.fromStatus && (
                          <Muted>{SUBSCRIPTION_STATUS_TEXT[entry.fromStatus]} → </Muted>
                        )}
                        {SUBSCRIPTION_STATUS_TEXT[entry.toStatus]}
                      </>
                    ) : (
                      <Muted>—</Muted>
                    )}
                  </td>
                  <td className="ac-text-body-s">{outcomeText(entry)}</td>
                </tr>
              ))}
            </Table>
          )}
        </div>
      </LoadingContent>
    </section>
  );
}

/** The garage to look at: a card per car (X7: «Основной», the document — badges). */
function Garage({ accountId }: { accountId: string }) {
  const garage = useLoad<AdminUserGarageResponse>(
    () => apiClient.getAdminUserGarage({ accountId }),
    `garage:${accountId}`,
  );
  const cars = garage.data?.cars ?? [];
  return (
    <div className="user-tab">
      <LoadError error={garage.error} retry={garage.reload} />
      <LoadingContent
        ready={garage.data !== undefined}
        indicator={garage.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={3} label="Загрузка" />}
      >
        {cars.length === 0 ? (
          <EmptyState compact icon="car" title="В гараже нет автомобилей" />
        ) : (
          <ul className="user-garage">
            {cars.map((car) => {
              const params = carParams(car);
              return (
                <li key={car.id} className="card user-car">
                  <span className="ac-text-body-strong">{carTitle(car)}</span>
                  {params && <span className="ac-text-body-s ac-muted">{params}</span>}
                  <span className="ac-text-body-s">
                    VIN {car.vin ?? <Muted>не указан</Muted>} · Госномер{" "}
                    {car.plate ? (
                      <span className="nowrap">{formatKzPlate(car.plate)}</span>
                    ) : (
                      <Muted>не указан</Muted>
                    )}
                  </span>
                  <span className="badges">
                    {car.isPrimary && (
                      <Badge tone="accent" icon="star">
                        Основной
                      </Badge>
                    )}
                    <Badge
                      tone={
                        car.document?.status === "shown"
                          ? "success"
                          : car.document?.status === "unconfirmed"
                            ? "warning"
                            : "neutral"
                      }
                      icon={car.document?.status === "shown" ? "circleCheck" : "info"}
                    >
                      {carDocumentText(car.document, (iso) => formatMoment(iso))}
                    </Badge>
                  </span>
                  <span className="ac-text-caption ac-muted">
                    Добавлен {formatMoment(car.createdAt)}
                  </span>
                </li>
              );
            })}
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
    <div className="user-tab">
      <LoadError error={list.first.error} retry={list.first.reload} />
      <LoadingContent
        ready={list.first.data !== undefined}
        indicator={list.first.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={4} label="Загрузка" />}
      >
        <div className="list-block">
          {list.items.length === 0 ? (
            <EmptyState compact icon="receipt" title="Заявок пока нет" />
          ) : (
            <>
              <TableToolbar total={list.total} />
              <OrdersTable orders={list.items} hide={["customer"]} />
            </>
          )}
          <MoreOrders list={list} />
        </div>
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
    <div className="user-tab user-tab--tight">
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
          <EmptyState
            compact
            icon="circleCheck"
            title="Неявок не было"
            text="Пользователь приходил за всем, что ему откладывали"
          />
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

/** The complaints of the user (A-USR-02, TASK-049): the rows of «Жалобы», the same empty state as the no-shows. */
function UserComplaints({ accountId }: { accountId: string }) {
  const { list } = useComplaintList({ accountId });
  return (
    <div className="user-tab">
      <LoadError error={list.first.error} retry={list.first.reload} />
      <LoadingContent
        ready={list.first.data !== undefined}
        indicator={list.first.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={3} label="Загрузка" />}
      >
        <div className="list-block">
          {list.items.length === 0 ? (
            <EmptyState
              compact
              icon="circleCheck"
              title="Жалоб нет"
              text="Пользователь не жаловался"
            />
          ) : (
            <>
              <TableToolbar total={list.total} />
              <ComplaintRows complaints={list.items} hide={["user"]} />
            </>
          )}
          <MoreOrders list={list} />
        </div>
      </LoadingContent>
    </div>
  );
}

/**
 * The sessions of the app (X22): the first ten, then «Показать все (N)»;
 * the device, the network in words («IP скрыт», X28), when it signed in and
 * was last used, «Завершить» on each — the same small button as a
 * supplier's sessions — and «Завершить все сессии (N)» with `danger` text.
 */
function Sessions({ accountId, onChanged }: { accountId: string; onChanged: () => void }) {
  const toast = useToast();
  const online = useOnline();
  const [key, setKey] = useState(0);
  const [all, setAll] = useState(false);
  const sessions = useLoad<AdminUserSessionListResponse>(
    () =>
      apiClient.listAdminUserSessions(
        { accountId },
        all ? undefined : { query: { limit: SESSIONS_SHOWN } },
      ),
    `sessions:${accountId}:${key}:${all ? "all" : "first"}`,
  );
  const [ending, setEnding] = useState<AdminUserSession | "all" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loaded = sessions.data?.sessions ?? [];
  // A server without pages answers all of them: the first ten are shown all the same.
  const list = all ? loaded : loaded.slice(0, SESSIONS_SHOWN);
  const total = (sessions.data?.total as number | undefined) ?? loaded.length;

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
    <div className="user-tab user-tab--tight">
      <div className="section__head">
        <p className="ac-text-body-s ac-muted user-sessions-note">
          Сессии приложения. Кабинет поставщика и админка этого же человека здесь не завершаются.
        </p>
        {total > 0 && (
          <Button
            variant="secondary"
            size="s"
            destructive
            disabled={!online}
            onClick={() => {
              setError(null);
              setEnding("all");
            }}
          >
            Завершить все сессии ({total})
          </Button>
        )}
      </div>
      <LoadError error={sessions.error} retry={sessions.reload} />
      <LoadingContent
        ready={sessions.data !== undefined}
        indicator={sessions.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={3} label="Загрузка" />}
      >
        <div className="list-block">
          {list.length === 0 ? (
            <EmptyState compact icon="devices" title="Активных сессий нет" />
          ) : (
            <Table
              label="Сессии приложения"
              columns={[
                { key: "device", header: "Устройство" },
                { key: "created", header: "Вход", width: 140 },
                { key: "used", header: "Последнее обращение", width: 180 },
                {
                  key: "actions",
                  header: "Действия",
                  actions: true,
                  hiddenHeader: true,
                  width: 128,
                },
              ]}
            >
              {list.map((session) => (
                <tr key={session.id}>
                  <td className="ac-text-body-s">
                    <span className="cell-stack">
                      <span>{deviceText(session)}</span>
                      <span className="ac-text-caption ac-muted">{ipText(session.ipHint)}</span>
                    </span>
                  </td>
                  <td className="ac-text-body-s nowrap">{formatMoment(session.createdAt)}</td>
                  <td className="ac-text-body-s nowrap">{formatMoment(session.lastUsedAt)}</td>
                  <td className="admin-table__actions">
                    <Button
                      variant="secondary"
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
            </Table>
          )}
          {!all && total > list.length && (
            <Button
              variant="secondary"
              size="s"
              loading={all && sessions.indicator}
              onClick={() => setAll(true)}
            >
              Показать все ({total})
            </Button>
          )}
        </div>
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
