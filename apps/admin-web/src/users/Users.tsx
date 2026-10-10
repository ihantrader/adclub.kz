import type { AdminUserSummary } from "@adclub/contracts";
import { Checkbox, EmptyState, LoadingContent, SkeletonList } from "@adclub/ui";
import { apiClient } from "../api";
import { AppLink, follow } from "../catalog/shared";
import { formatMoment } from "../format";
import { routePaths, userPath } from "../router";
import { SearchBox, useAddressFilters } from "../suppliers/shared";
import { LoadError, MoreButton, usePaged } from "../vehicles/shared";
import { accessText, userFiltersOf } from "./user-words";

const ACCESS = [
  { value: "", label: "Все" },
  { value: "active", label: "Есть" },
  { value: "none", label: "Нет" },
  { value: "expiring", label: "Истекает в ближайшие N дней" },
] as const;

const TABS = [
  { key: "users", label: "Пользователи", href: routePaths.users },
  { key: "noShows", label: "Неявки", href: routePaths.userNoShows },
] as const;

/** The pages of «Пользователи» (A-USR-01, A-USR-03): real links with their own addresses. */
export function UsersTabs({ active }: { active: (typeof TABS)[number]["key"] | null }) {
  return (
    <nav className="page-tabs" aria-label="Пользователи">
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

/**
 * A-USR-01 «Пользователи» (SCREENS 7.6; TASK-036.B): the users of the app,
 * newest first; the search by the phone (any spelling, a part of it — the
 * server matches the full number and answers it partly hidden) and the
 * name; club access (until TASK-040 — in place of the subscription's
 * status): now, none, ending within N days; «есть неявки». A user who
 * never finished the registration is listed by the number alone. «Нет
 * WhatsApp» is not offered: the server knows nothing of it about users'
 * numbers.
 */
export function Users() {
  const { query, set } = useAddressFilters();
  const filters = userFiltersOf(query);
  const list = usePaged<AdminUserSummary & { id: string }>(async (cursor) => {
    const page = await apiClient.listAdminUsers({ query: { ...filters, limit: 50, cursor } });
    return {
      items: page.users.map((user) => ({ ...user, id: user.accountId })),
      total: page.total,
      nextCursor: page.nextCursor,
    };
  }, JSON.stringify(filters));

  return (
    <>
      <div className="page__head">
        <h1 className="ac-text-title-l page__title">Пользователи</h1>
      </div>
      <UsersTabs active="users" />
      <div className="filters">
        <SearchBox label="Телефон (можно часть) или имя" />
        <label className="select">
          <span className="ac-text-caption ac-muted">Клубный доступ</span>
          <select
            value={filters.clubAccess ?? ""}
            onChange={(event) => set({ clubAccess: event.target.value || undefined })}
          >
            {ACCESS.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
        {filters.clubAccess === "expiring" && (
          <label className="select select--narrow">
            <span className="ac-text-caption ac-muted">N дней</span>
            <input
              type="number"
              min={1}
              max={366}
              value={filters.expiringDays}
              onChange={(event) => set({ expiringDays: event.target.value || undefined })}
            />
          </label>
        )}
        <Checkbox
          label="Есть неявки"
          checked={filters.noShows === "true"}
          onChange={(on) => set({ noShows: on ? "true" : undefined })}
        />
        <Checkbox
          label="Есть автомобиль без подтверждённого документа"
          checked={filters.unconfirmedCar === "true"}
          onChange={(on) => set({ unconfirmedCar: on ? "true" : undefined })}
        />
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
            icon="users"
            title="Пользователей не найдено"
            text="Измените поиск или отборы"
          />
        ) : (
          <div className="table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th scope="col">Пользователь</th>
                  <th scope="col">Город</th>
                  <th scope="col">Клубный доступ</th>
                  <th scope="col" className="num">
                    Неявки
                  </th>
                  <th scope="col">Появился</th>
                </tr>
              </thead>
              <tbody>
                {list.items.map((user) => (
                  <tr key={user.accountId}>
                    <td>
                      <div className="cell-stack">
                        <AppLink href={userPath(user.accountId)}>
                          {user.name ?? "Без имени"}
                        </AppLink>
                        <span className="ac-text-caption ac-muted num">
                          {user.phone}
                          {!user.registrationCompleted ? " · регистрация не завершена" : ""}
                          {user.supplierMember ? " · сотрудник поставщика" : ""}
                        </span>
                      </div>
                    </td>
                    <td>{user.cityName ?? <span className="ac-muted">—</span>}</td>
                    <td>
                      <span
                        className={
                          user.clubAccess.granted
                            ? "status status--acknowledged"
                            : "status status--closed"
                        }
                      >
                        {accessText(user.clubAccess)}
                      </span>
                    </td>
                    <td className="num">{user.noShows}</td>
                    <td className="ac-text-body-s num">{formatMoment(user.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <MoreButton list={list} />
      </LoadingContent>
    </>
  );
}
