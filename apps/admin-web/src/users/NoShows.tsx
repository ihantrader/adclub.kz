import type { AdminDisciplineUser, AdminDisciplineUsersPage } from "@adclub/contracts";
import {
  Banner,
  Button,
  EmptyState,
  IconButton,
  LoadingContent,
  Select,
  SkeletonList,
  TableToolbar,
} from "@adclub/ui";
import { useState } from "react";
import { apiClient } from "../api";
import { almatyDayStart } from "../audit/audit-words";
import { loadErrorText } from "../errors";
import { formatMoment } from "../format";
import { Header, RowTitle, rowLink, Table } from "../layout/layout";
import { Period } from "../orders/Orders";
import { userPath } from "../router";
import { useAddressFilters } from "../suppliers/shared";
import { useLoad } from "../use-load";
import { LoadError } from "../vehicles/shared";
import { usersTabs } from "./Users";
import "./users.css";

const PAGE = 50;

type Sort = "count" | "last";

/**
 * A-USR-03 «Неявки» (SCREENS 7.6; TASK-036.B, TASK-080): a page of
 * «Пользователи» (the title stays the section's, X11) — who did not come
 * for an item put aside for them: how many no-shows in the period, how many
 * were lifted, the last one; most first or the latest first; the period in
 * days of Almaty. The row opens the user's «Дисциплина».
 */
export function NoShows() {
  const { query, set } = useAddressFilters();
  const sort: Sort = query.get("sort") === "last" ? "last" : "count";
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
  const filtered = Boolean(from || to);

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
      <Header
        title="Пользователи"
        tabs={usersTabs("noShows")}
        actions={<IconButton icon="refresh" label="Обновить" size={20} onClick={first.reload} />}
      />
      <div className="filters">
        <Select<Sort>
          compact
          label="Сортировка"
          value={sort}
          className="filters__select users-sort"
          options={[
            { value: "count", label: "Больше неявок — выше" },
            { value: "last", label: "Недавняя неявка — выше" },
          ]}
          onChange={(next) => set({ sort: next === "last" ? "last" : undefined })}
        />
        <Period from={from} to={to} onChange={(patch) => set(patch)} />
      </div>
      <LoadError error={first.error} retry={first.reload} />
      <LoadingContent
        ready={first.data !== undefined}
        indicator={first.indicator}
        label="Загрузка"
        swapKey={first.answerKey}
        skeleton={<SkeletonList rows={5} label="Загрузка" />}
      >
        <div className="list-block">
          <TableToolbar total={users.length === 0 ? null : (first.data?.total ?? 0)}>
            {filtered && (
              <Button
                variant="text"
                size="s"
                onClick={() => set({ from: undefined, to: undefined })}
              >
                Сбросить фильтры
              </Button>
            )}
          </TableToolbar>
          {users.length === 0 ? (
            <EmptyState
              icon="circleCheck"
              title="Неявок нет"
              text="За этот период все приходили за отложенным"
            />
          ) : (
            <Table
              label="Неявки"
              columns={[
                { key: "user", header: "Пользователь" },
                { key: "count", header: "Неявок за период", width: 160, numeric: true },
                { key: "revoked", header: "Снято", width: 104, numeric: true },
                { key: "last", header: "Последняя неявка", width: 160 },
              ]}
            >
              {users.map((user) => {
                const href = userPath(user.accountId, "discipline");
                return (
                  <tr key={user.accountId} {...rowLink(href)}>
                    <td>
                      <RowTitle href={href} sub={user.name ? user.phone : "Без имени"}>
                        <span className={user.name ? undefined : "nowrap"}>
                          {user.name ?? user.phone}
                        </span>
                      </RowTitle>
                    </td>
                    <td className="num">{user.count.toLocaleString("ru-RU")}</td>
                    <td className="num">
                      {user.revokedCount > 0 ? (
                        user.revokedCount.toLocaleString("ru-RU")
                      ) : (
                        <span className="ac-muted">—</span>
                      )}
                    </td>
                    <td className="ac-text-body-s nowrap">{formatMoment(user.lastAt)}</td>
                  </tr>
                );
              })}
            </Table>
          )}
          {moreError && <Banner tone="danger">{moreError}</Banner>}
          {next !== null && (
            <Button variant="secondary" size="s" onClick={loadMore} loading={loadingMore}>
              Показать ещё
            </Button>
          )}
        </div>
      </LoadingContent>
    </>
  );
}
