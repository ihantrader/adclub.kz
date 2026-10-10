import type { AdminDisciplineUser, AdminDisciplineUsersPage } from "@adclub/contracts";
import { Banner, Button, EmptyState, LoadingContent, SkeletonList } from "@adclub/ui";
import { useState } from "react";
import { apiClient } from "../api";
import { almatyDayStart } from "../audit/audit-words";
import { AppLink } from "../catalog/shared";
import { loadErrorText } from "../errors";
import { formatMoment } from "../format";
import { userPath } from "../router";
import { useAddressFilters } from "../suppliers/shared";
import { useLoad } from "../use-load";
import { LoadError } from "../vehicles/shared";
import { UsersTabs } from "./Users";

const PAGE = 50;

/**
 * A-USR-03 «Неявки» (SCREENS 7.6; TASK-036.B): who did not come for an
 * item put aside for them — how many no-shows in the period (lifted ones
 * apart), the last one; most first or the latest first; the period in
 * days of Almaty. The marks themselves — on the user's card.
 */
export function NoShows() {
  const { query, set } = useAddressFilters();
  const sort = query.get("sort") === "last" ? "last" : "count";
  const from = query.get("from") ?? "";
  const to = query.get("to") ?? "";
  const key = JSON.stringify({ sort, from, to });
  const request = (offset: number) =>
    apiClient.listAdminDisciplineUsers({
      query: { sort, from: almatyDayStart(from), to: almatyDayStart(to, 1), limit: PAGE, offset },
    });
  const first = useLoad<AdminDisciplineUsersPage>(() => request(0), key);
  const [more, setMore] = useState<{
    key: string;
    users: AdminDisciplineUser[];
    next: number | null;
  }>({ key: "", users: [], next: null });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const extra = more.key === key ? more : { key, users: [], next: null };
  const users = [...(first.data?.users ?? []), ...extra.users];
  const next = extra.users.length > 0 ? extra.next : (first.data?.nextOffset ?? null);

  const loadMore = async () => {
    if (next === null) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await request(next);
      setMore({ key, users: [...extra.users, ...page.users], next: page.nextOffset });
    } catch (thrown) {
      setMoreError(loadErrorText(thrown));
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <>
      <div className="page__head">
        <h1 className="ac-text-title-l page__title">Неявки</h1>
      </div>
      <UsersTabs active="noShows" />
      <div className="filters">
        <label className="select">
          <span className="ac-text-caption ac-muted">Сортировка</span>
          <select
            value={sort}
            onChange={(event) => set({ sort: event.target.value === "last" ? "last" : undefined })}
          >
            <option value="count">Больше неявок — выше</option>
            <option value="last">Недавняя неявка — выше</option>
          </select>
        </label>
        <label className="select">
          <span className="ac-text-caption ac-muted">С (время Алматы)</span>
          <input
            type="date"
            value={from}
            onChange={(event) => set({ from: event.target.value || undefined })}
          />
        </label>
        <label className="select">
          <span className="ac-text-caption ac-muted">По</span>
          <input
            type="date"
            value={to}
            onChange={(event) => set({ to: event.target.value || undefined })}
          />
        </label>
      </div>
      <LoadError error={first.error} retry={first.reload} />
      <LoadingContent
        ready={first.data !== undefined}
        indicator={first.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={5} label="Загрузка" />}
      >
        <p className="ac-text-body-s ac-muted">
          Всего: {(first.data?.total ?? 0).toLocaleString("ru-RU")}
        </p>
        {users.length === 0 ? (
          <EmptyState
            icon="circleCheck"
            title="Неявок нет"
            text="За этот период все приходили за отложенным"
          />
        ) : (
          <div className="table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th scope="col">Пользователь</th>
                  <th scope="col" className="num">
                    Неявок за период
                  </th>
                  <th scope="col" className="num">
                    Снято
                  </th>
                  <th scope="col">Последняя неявка</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.accountId}>
                    <td>
                      <div className="cell-stack">
                        <AppLink href={userPath(user.accountId, "discipline")}>
                          {user.name ?? "Без имени"}
                        </AppLink>
                        <span className="ac-text-caption ac-muted num">{user.phone}</span>
                      </div>
                    </td>
                    <td className="num">{user.count}</td>
                    <td className="num">{user.revokedCount}</td>
                    <td className="ac-text-body-s num">{formatMoment(user.lastAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {moreError && <Banner tone="danger">{moreError}</Banner>}
        {next !== null && (
          <Button variant="secondary" onClick={loadMore} loading={loadingMore}>
            Показать ещё
          </Button>
        )}
      </LoadingContent>
    </>
  );
}
