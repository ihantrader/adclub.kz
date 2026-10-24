import type { AdminUserSummary } from "@adclub/contracts";
import {
  Badge,
  Button,
  EmptyState,
  IconButton,
  LoadingContent,
  SkeletonList,
  TableToolbar,
  TextField,
  TypeMark,
} from "@adclub/ui";
import { useEffect, useState } from "react";
import { apiClient } from "../api";
import { formatMoment } from "../format";
import { FilterSearch, FilterSelect, FlagChips } from "../layout/filters";
import { Header, RowTitle, rowLink, Table } from "../layout/layout";
import { MoreOrders } from "../orders/Orders";
import { navigateTo, routePaths, userPath } from "../router";
import { useAddressFilters } from "../suppliers/shared";
import { LoadError, usePaged } from "../vehicles/shared";
import { accessMark, userFiltersOf } from "./user-words";
import "./users.css";

const ACCESS = [
  { value: "active", label: "Есть" },
  { value: "none", label: "Нет" },
  { value: "expiring", label: "Истекает в ближайшие N дней" },
] as const;

const FLAGS = [
  { key: "noShows", label: "Есть неявки" },
  { key: "unconfirmedCar", label: "Есть автомобиль без подтверждённого документа" },
] as const;

type FlagKey = (typeof FLAGS)[number]["key"];

type UsersPage = "users" | "noShows";

/** The pages of «Пользователи» (A-USR-01, A-USR-03): one bar of the section's tabs (X11). */
export function usersTabs(active: UsersPage) {
  return {
    label: "Пользователи",
    active,
    items: [
      { key: "users" as const, label: "Все", href: routePaths.users },
      { key: "noShows" as const, label: "Неявки", href: routePaths.userNoShows },
    ],
  };
}

export const USERS_CRUMB = { label: "Пользователи", href: routePaths.users };

/**
 * Club access as a mark (X7): «До 17.11 · подписка», «Истекает 27.10»,
 * «Нет» — the same in the list and on the card.
 */
export function AccessMark({ state }: { state: AdminUserSummary["clubAccess"] }) {
  const mark = accessMark(state);
  return (
    <Badge tone={mark.tone} icon={mark.icon}>
      {mark.text}
    </Badge>
  );
}

/**
 * A-USR-01 «Пользователи» (SCREENS 7.6; TASK-036.B, TASK-080): the users of
 * the app, newest first; the search by the phone (any spelling, a part of
 * it — the server matches the full number and answers it partly hidden)
 * and the name; club access now, none, ending within N days; the flags
 * «есть неявки» and «автомобиль без подтверждённого документа» as chips in
 * one row. A user who never finished the registration is listed by the
 * number. The row opens the user (X1). «Нет WhatsApp» is not offered: the
 * server knows nothing of it about users' numbers.
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
  const [search, setSearch] = useState(query.get("q") ?? "");
  const [days, setDays] = useState(query.get("expiringDays") ?? String(filters.expiringDays));
  const filtered = Boolean(
    filters.q || filters.clubAccess || filters.noShows || filters.unconfirmedCar,
  );

  // The search goes to the address a moment after typing stops.
  useEffect(() => {
    const trimmed = search.trim();
    if (trimmed === (query.get("q") ?? "")) return;
    const timer = setTimeout(() => set({ q: trimmed || undefined }), 350);
    return () => clearTimeout(timer);
  });

  const reset = () => {
    setSearch("");
    navigateTo(routePaths.users, { replace: true });
  };

  return (
    <>
      <Header
        title="Пользователи"
        tabs={usersTabs("users")}
        actions={
          <IconButton icon="refresh" label="Обновить" size={20} onClick={list.first.reload} />
        }
      />
      <div className="filters__group">
        <div className="filters">
          <FilterSearch
            label="Поиск пользователей"
            placeholder="Телефон (можно часть) или имя"
            value={search}
            onChange={setSearch}
            onSubmit={() => set({ q: search.trim() || undefined })}
          />
          <FilterSelect
            label="Клубный доступ"
            value={filters.clubAccess}
            options={ACCESS}
            onChange={(clubAccess) => set({ clubAccess })}
          />
          {filters.clubAccess === "expiring" && (
            <TextField
              className="ac-field--compact users-days"
              label="N дней"
              value={days}
              inputMode="numeric"
              maxLength={3}
              onChange={(text) => {
                const digits = text.replace(/\D/g, "");
                setDays(digits);
                const value = Number(digits);
                if (value >= 1 && value <= 366) set({ expiringDays: digits });
              }}
            />
          )}
        </div>
        <FlagChips<FlagKey>
          label="Отборы пользователей"
          flags={FLAGS}
          isOn={(key) => filters[key] === "true"}
          onToggle={(key, on) => set({ [key]: on ? "true" : undefined })}
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
              icon="users"
              title={filtered ? "Пользователей не найдено" : "Пользователей пока нет"}
              text={filtered ? "Измените поиск или отборы" : undefined}
              action={
                filtered ? (
                  <Button variant="secondary" onClick={reset}>
                    Сбросить фильтры
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <Table
              label="Пользователи"
              columns={[
                { key: "user", header: "Пользователь" },
                { key: "city", header: "Город", width: 180 },
                { key: "access", header: "Клубный доступ", width: 220 },
                { key: "noShows", header: "Неявки", width: 104, numeric: true },
                { key: "created", header: "Появился", width: 140 },
              ]}
            >
              {list.items.map((user) => {
                const href = userPath(user.accountId);
                const notes = [
                  user.name ? user.phone : "Без имени",
                  user.registrationCompleted ? null : "регистрация не завершена",
                ].filter(Boolean);
                return (
                  <tr key={user.accountId} {...rowLink(href)}>
                    <td>
                      <RowTitle
                        href={href}
                        sub={
                          <span className="users-sub">
                            <span className="nowrap">{notes.join(" · ")}</span>
                            {user.supplierMember && (
                              <TypeMark icon="store">Сотрудник поставщика</TypeMark>
                            )}
                          </span>
                        }
                      >
                        <span className={user.name ? undefined : "nowrap"}>
                          {user.name ?? user.phone}
                        </span>
                      </RowTitle>
                    </td>
                    <td className="ac-text-body-s">
                      {user.cityName ?? <span className="ac-muted">—</span>}
                    </td>
                    <td>
                      <AccessMark state={user.clubAccess} />
                    </td>
                    <td className="num">
                      {user.noShows > 0 && (
                        <Badge tone="warning" icon="alertTriangle">
                          {user.noShows.toLocaleString("ru-RU")}
                        </Badge>
                      )}
                    </td>
                    <td className="ac-text-body-s nowrap">{formatMoment(user.createdAt)}</td>
                  </tr>
                );
              })}
            </Table>
          )}
          <MoreOrders list={list} />
        </div>
      </LoadingContent>
    </>
  );
}
