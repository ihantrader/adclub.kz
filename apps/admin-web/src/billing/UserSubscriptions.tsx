import type {
  AdminBillingUserSubscription,
  AdminUserSubscriptionPage,
  SubscriptionProviderValue,
  SubscriptionStatusValue,
} from "@adclub/contracts";
import {
  Button,
  EmptyState,
  IconButton,
  LoadingContent,
  SkeletonList,
  TableToolbar,
  TextField,
} from "@adclub/ui";
import { useEffect, useState } from "react";
import { apiClient } from "../api";
import { formatDay } from "../format";
import { FilterSearch, FilterSelect, StatusChips } from "../layout/filters";
import { Header, Muted, RowTitle, rowLink, Table } from "../layout/layout";
import { MoreOrders } from "../orders/Orders";
import { navigateTo, routePaths, userPath, withQuery } from "../router";
import { useAddressFilters } from "../suppliers/shared";
import {
  SUBSCRIPTION_EVENT_TEXT,
  SUBSCRIPTION_PROVIDER_TEXT,
  SUBSCRIPTION_STATUS_TEXT,
} from "../users/subscription-words";
import { LoadError, usePaged } from "../vehicles/shared";
import { billingTabs, PLATFORM_TEXT, userSubscriptionFiltersOf } from "./billing-words";
import "./billing.css";

type Tab = "active" | "ended" | "all";

const USER_STATUSES: readonly SubscriptionStatusValue[] = [
  "active",
  "grace",
  "cancelled",
  "expired_unconfirmed",
  "suspended",
  "expired",
];

const PROVIDERS: readonly SubscriptionProviderValue[] = ["store", "test"];

/**
 * A-BILL-02 «Подписки пользователей» (SCREENS 7.8; TASK-043): «Действующие»
 * (give club access now), «Прекращённые» (give none), «Все»; the filters in
 * the address — status, platform, provider, ending within N days, started or
 * ended in a period (from the summary), the phone (a part of it) or the
 * name. The row opens the user on «Клубный доступ». Grants by hand are not
 * subscriptions and are not here.
 */
export function UserSubscriptions() {
  const { query, set } = useAddressFilters();
  const filters = userSubscriptionFiltersOf(query);
  const [counts, setCounts] = useState<AdminUserSubscriptionPage["counts"] | null>(null);
  const list = usePaged<AdminBillingUserSubscription>(async (cursor) => {
    const page = await apiClient.listAdminUserSubscriptions({
      query: { ...filters, limit: 50, cursor },
    });
    setCounts(page.counts);
    return { items: page.subscriptions, total: page.total, nextCursor: page.nextCursor };
  }, JSON.stringify(filters));
  const [search, setSearch] = useState(query.get("q") ?? "");
  const [days, setDays] = useState(query.get("expiringDays") ?? "");
  const period =
    filters.startedFrom || filters.startedTo
      ? `Оформлены с ${formatDay(filters.startedFrom)} по ${formatDay(endDay(filters.startedTo))}`
      : filters.endedFrom || filters.endedTo
        ? `Прекращены с ${formatDay(filters.endedFrom)} по ${formatDay(endDay(filters.endedTo))}`
        : null;
  const filtered = Boolean(
    filters.status ||
    filters.platform ||
    filters.provider ||
    filters.expiringDays ||
    filters.q ||
    filters.accountId ||
    period,
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
    setDays("");
    navigateTo(withQuery(routePaths.billingUsers, { tab: filters.tab }), { replace: true });
  };

  return (
    <>
      <Header
        title="Биллинг"
        tabs={billingTabs("users")}
        actions={
          <IconButton icon="refresh" label="Обновить" size={20} onClick={list.first.reload} />
        }
      />
      <StatusChips<Tab>
        label="Подписки"
        value={filters.tab}
        allLabel={null}
        chips={[
          { value: "active", label: "Действующие", count: counts?.active },
          { value: "ended", label: "Прекращённые", count: counts?.ended },
          { value: "all", label: "Все", count: counts?.all },
        ]}
        onChange={(tab) => set({ tab: tab === "active" ? undefined : tab })}
      />
      <div className="filters__group">
        <div className="filters">
          <FilterSearch
            label="Поиск подписок"
            placeholder="Телефон (можно часть) или имя"
            value={search}
            onChange={setSearch}
            onSubmit={() => set({ q: search.trim() || undefined })}
          />
          <FilterSelect<SubscriptionStatusValue>
            label="Статус"
            value={filters.status}
            options={USER_STATUSES.map((value) => ({
              value,
              label: SUBSCRIPTION_STATUS_TEXT[value],
            }))}
            onChange={(status) => set({ status })}
          />
          <FilterSelect<"ios" | "android" | "other">
            label="Платформа"
            value={filters.platform}
            options={(["ios", "android", "other"] as const).map((value) => ({
              value,
              label: PLATFORM_TEXT[value],
            }))}
            onChange={(platform) => set({ platform })}
          />
          <FilterSelect<SubscriptionProviderValue>
            label="Провайдер"
            value={filters.provider}
            options={PROVIDERS.map((value) => ({
              value,
              label: SUBSCRIPTION_PROVIDER_TEXT[value],
            }))}
            onChange={(provider) => set({ provider })}
          />
          <TextField
            className="ac-field--compact billing-days"
            label="Истекает в ближайшие N дней"
            value={days}
            inputMode="numeric"
            maxLength={3}
            onChange={(text) => {
              const digits = text.replace(/\D/g, "");
              setDays(digits);
              const value = Number(digits);
              if (digits === "") set({ expiringDays: undefined });
              else if (value >= 1 && value <= 366) set({ expiringDays: digits });
            }}
          />
        </div>
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
            {period && <span>{period}</span>}
            {filtered && (
              <Button variant="text" size="s" onClick={reset}>
                Сбросить фильтры
              </Button>
            )}
          </TableToolbar>
          {list.items.length === 0 ? (
            <EmptyState
              icon="users"
              title={filtered ? "Подписок не найдено" : "Подписок пока нет"}
              text={filtered ? "Измените поиск или отборы" : undefined}
            />
          ) : (
            <Table
              label="Подписки пользователей"
              columns={[
                { key: "user", header: "Пользователь" },
                { key: "status", header: "Статус", width: 250 },
                { key: "platform", header: "Платформа", width: 120 },
                { key: "paid", header: "Оплачено до", width: 130 },
                { key: "access", header: "Доступ до", width: 130 },
                { key: "started", header: "Начало", width: 130 },
                { key: "ended", header: "Прекращена", width: 210 },
              ]}
            >
              {list.items.map((row) => {
                const href = userPath(row.accountId, "access");
                return (
                  <tr key={row.id} {...rowLink(href)}>
                    <td>
                      <RowTitle href={href} sub={row.name ? row.phone : undefined}>
                        <span className={row.name ? undefined : "nowrap"}>
                          {row.name ?? row.phone}
                        </span>
                      </RowTitle>
                    </td>
                    <td className="ac-text-body-s">
                      {SUBSCRIPTION_STATUS_TEXT[row.status]}
                      <Muted> · {SUBSCRIPTION_PROVIDER_TEXT[row.provider]}</Muted>
                    </td>
                    <td className="ac-text-body-s">
                      {row.platform ? (
                        PLATFORM_TEXT[row.platform]
                      ) : (
                        <Muted>{PLATFORM_TEXT.other}</Muted>
                      )}
                    </td>
                    <td className="ac-text-body-s nowrap">{formatDay(row.periodEnd)}</td>
                    <td className="ac-text-body-s nowrap">
                      {row.accessUntil ? formatDay(row.accessUntil) : <Muted>нет доступа</Muted>}
                    </td>
                    <td className="ac-text-body-s nowrap">
                      {row.startedAt ? formatDay(row.startedAt) : <Muted>—</Muted>}
                    </td>
                    <td className="ac-text-body-s">
                      {row.ended ? (
                        <>
                          {formatDay(row.ended.at)}
                          <Muted>
                            {" "}
                            ·{" "}
                            {SUBSCRIPTION_EVENT_TEXT[row.ended.kind] ??
                              endedKindText(row.ended.kind)}
                          </Muted>
                        </>
                      ) : (
                        <Muted>—</Muted>
                      )}
                    </td>
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

/** The last day of a period whose end is the next day's 00:00. */
function endDay(iso: string | undefined): string | undefined {
  return iso ? new Date(new Date(iso).getTime() - 1).toISOString() : undefined;
}

function endedKindText(kind: string): string {
  return kind === "replaced" ? "заменена новой подпиской" : kind;
}
