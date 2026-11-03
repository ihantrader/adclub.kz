import type {
  AdminBillingSupplier,
  AdminBillingSupplierPage,
  AdminCharge,
  AdminChargeStatus,
  SupplierBillingGroup,
  SupplierChargeKind,
} from "@adclub/contracts";
import {
  Badge,
  Button,
  Chip,
  ChipRow,
  EmptyState,
  IconButton,
  LoadingContent,
  SkeletonList,
  StatusBadge,
  TableToolbar,
} from "@adclub/ui";
import type { IconName, Tone } from "@adclub/ui-core";
import { useEffect, useState } from "react";
import { apiClient } from "../api";
import { formatDay, formatMoment } from "../format";
import { FilterSearch, FilterSelect, StatusChips } from "../layout/filters";
import { Header, Muted, RowTitle, rowLink, Table } from "../layout/layout";
import { MoreOrders, Period, useSupplierChoice } from "../orders/Orders";
import { navigateTo, routePaths, supplierPath, withQuery } from "../router";
import { SearchSelect } from "../search-select/SearchSelect";
import { createChoiceSources } from "../search-select/sources";
import {
  amountText,
  CHARGE_KIND_TEXT,
  DECLINE_REASON_TEXT,
  SUPPLIER_SUBSCRIPTION_TEXT,
} from "../suppliers/billing-words";
import { useAddressFilters } from "../suppliers/shared";
import { LoadError, usePaged } from "../vehicles/shared";
import {
  ALL_GROUPS,
  billingTabs,
  CHARGE_STATUS_TEXT,
  CHARGE_STATUSES,
  dayStart,
  failedFacts,
  FAILED_GROUPS,
  GROUP_HINT,
  GROUP_TEXT,
  groupsOf,
  paymentsTabOf,
  type PaymentsTab,
} from "./billing-words";
import "./billing.css";

const supplierSearch = createChoiceSources(apiClient).suppliers();

const VIEWS: { value: PaymentsTab; label: string }[] = [
  { value: "failed", label: "Неуспешные" },
  { value: "history", label: "История списаний" },
  { value: "suppliers", label: "Все поставщики" },
];

const KINDS: readonly SupplierChargeKind[] = ["first", "scheduled", "manual", "retry"];

const countKey: Record<SupplierBillingGroup, keyof AdminBillingSupplierPage["counts"]> = {
  paid: "paid",
  declined: "declined",
  awaiting_provider: "awaitingProvider",
  paused: "paused",
  none: "none",
};

/**
 * A-BILL-03 «Платежи поставщиков» (SCREENS 7.8; TASK-043): «Неуспешные» —
 * the refusals of the bank with their try, the next try and the days to the
 * pause (the same rule as the cabinet and W-05), the charges waiting for
 * the payment system (not a failure of the payer), the pauses; «История
 * списаний» — every charge by period, supplier, status and kind; «Все
 * поставщики» — every company in its one group (the cards of the summary).
 * The card is its mask only.
 */
export function Payments() {
  const { query, set } = useAddressFilters();
  const tab = paymentsTabOf(query);
  return (
    <>
      <Header title="Биллинг" tabs={billingTabs("payments")} />
      <StatusChips<PaymentsTab>
        label="Раздел платежей"
        value={tab}
        allLabel={null}
        chips={VIEWS}
        onChange={(next) =>
          navigateTo(
            withQuery(routePaths.billingPayments, { tab: next === "failed" ? undefined : next }),
          )
        }
      />
      {tab === "history" ? (
        <History query={query} set={set} />
      ) : (
        <SuppliersList key={tab} tab={tab} query={query} set={set} />
      )}
    </>
  );
}

function SuppliersList({
  tab,
  query,
  set,
}: {
  tab: "failed" | "suppliers";
  query: URLSearchParams;
  set: (patch: Record<string, string | undefined>) => void;
}) {
  const offered = tab === "failed" ? FAILED_GROUPS : ALL_GROUPS;
  const asked = groupsOf(query).filter((group) => offered.includes(group));
  const groups = asked.length > 0 ? asked : offered;
  const q = query.get("q")?.trim() || undefined;
  const [search, setSearch] = useState(q ?? "");
  const [counts, setCounts] = useState<AdminBillingSupplierPage["counts"] | null>(null);

  // The search goes to the address a moment after typing stops.
  useEffect(() => {
    const trimmed = search.trim();
    if (trimmed === (q ?? "")) return;
    const timer = setTimeout(() => set({ q: trimmed || undefined }), 350);
    return () => clearTimeout(timer);
  });
  const list = usePaged<AdminBillingSupplier & { id: string }>(
    async (cursor) => {
      const page = await apiClient.listAdminBillingSuppliers({
        query: { groups: groups.join(","), q, limit: 50, cursor },
      });
      setCounts(page.counts);
      return {
        items: page.suppliers.map((row) => ({ ...row, id: row.supplierId })),
        total: page.total,
        nextCursor: page.nextCursor,
      };
    },
    `${groups.join(",")}|${q ?? ""}`,
  );
  const toggle = (group: SupplierBillingGroup) => {
    const on = asked.includes(group);
    const next = on ? asked.filter((entry) => entry !== group) : [...asked, group];
    set({ groups: next.length > 0 ? next.join(",") : undefined });
  };

  return (
    <>
      <div className="filters__group">
        <div className="filters">
          <FilterSearch
            label="Поиск поставщиков"
            placeholder="Название или цифры БИН"
            value={search}
            onChange={setSearch}
            onSubmit={() => set({ q: search.trim() || undefined })}
          />
          <IconButton icon="refresh" label="Обновить" size={20} onClick={list.first.reload} />
        </div>
        <ChipRow label="Группы поставщиков">
          {offered.map((group) => (
            <Chip key={group} selected={asked.includes(group)} onClick={() => toggle(group)}>
              {GROUP_TEXT[group]}
              {counts && (
                <span className="chip-count">
                  {counts[countKey[group]].toLocaleString("ru-RU")}
                </span>
              )}
            </Chip>
          ))}
        </ChipRow>
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
          <TableToolbar total={list.items.length === 0 ? null : list.total} />
          {list.items.length === 0 ? (
            <EmptyState
              icon="creditCard"
              title={tab === "failed" ? "Неуспешных платежей нет" : "Поставщиков не найдено"}
              text={groups.length === 1 ? GROUP_HINT[groups[0]!] : undefined}
            />
          ) : tab === "failed" ? (
            <FailedTable rows={list.items} />
          ) : (
            <SupplierTable rows={list.items} />
          )}
          <MoreOrders list={list} />
        </div>
      </LoadingContent>
    </>
  );
}

const GROUP_MARK: Record<SupplierBillingGroup, { tone: Tone; icon: IconName }> = {
  paid: { tone: "success", icon: "circleCheck" },
  declined: { tone: "warning", icon: "alertTriangle" },
  awaiting_provider: { tone: "neutral", icon: "clock" },
  paused: { tone: "danger", icon: "pause" },
  none: { tone: "neutral", icon: "creditCard" },
};

function GroupMark({ row }: { row: AdminBillingSupplier }) {
  const mark = GROUP_MARK[row.group];
  return (
    <span title={GROUP_HINT[row.group]}>
      <Badge tone={mark.tone} icon={mark.icon}>
        {GROUP_TEXT[row.group]}
      </Badge>
    </span>
  );
}

function SupplierName({ row }: { row: AdminBillingSupplier }) {
  const href = supplierPath(row.supplierId, "billing");
  return (
    <RowTitle href={href} sub={row.adminPaused ? "и пауза администратора" : undefined}>
      {row.name}
    </RowTitle>
  );
}

function FailedTable({ rows }: { rows: (AdminBillingSupplier & { id: string })[] }) {
  return (
    <Table
      label="Неуспешные платежи поставщиков"
      columns={[
        { key: "supplier", header: "Поставщик" },
        { key: "group", header: "Что с оплатой", width: 200 },
        { key: "amount", header: "Сумма", width: 112, numeric: true },
        { key: "reason", header: "Причина", width: 220 },
        { key: "try", header: "Попытка", width: 170 },
        { key: "next", header: "Следующая попытка", width: 210 },
        { key: "pause", header: "До паузы", width: 190 },
      ]}
    >
      {rows.map((row) => {
        const facts = failedFacts(row);
        const amount = row.lastDecline?.amount ?? row.waiting?.amount ?? null;
        return (
          <tr key={row.id} {...rowLink(supplierPath(row.supplierId, "billing"))}>
            <td>
              <SupplierName row={row} />
            </td>
            <td>
              <GroupMark row={row} />
            </td>
            <td className="num">{amount === null ? <Muted>—</Muted> : amountText(amount)}</td>
            <td className="ac-text-body-s">
              {row.group === "awaiting_provider" && row.waiting ? (
                row.waiting.status === "unknown" ? (
                  "Исход неизвестен: ответ платёжной системы потерян"
                ) : (
                  "Платёжная система недоступна"
                )
              ) : row.lastDecline ? (
                DECLINE_REASON_TEXT[row.lastDecline.reason]
              ) : (
                <Muted>—</Muted>
              )}
            </td>
            <td className="ac-text-body-s">
              {row.declines > 0 ? (
                <>
                  {`${String(row.declines)}-я`}
                  {row.lastDecline && <Muted> · {formatMoment(row.lastDecline.at)}</Muted>}
                </>
              ) : row.waiting ? (
                <Muted>с {formatMoment(row.waiting.since)}</Muted>
              ) : (
                <Muted>—</Muted>
              )}
            </td>
            <td className="ac-text-body-s">{facts.next}</td>
            <td className="ac-text-body-s">{facts.pause ?? <Muted>—</Muted>}</td>
          </tr>
        );
      })}
    </Table>
  );
}

function SupplierTable({ rows }: { rows: (AdminBillingSupplier & { id: string })[] }) {
  return (
    <Table
      label="Поставщики по оплате"
      columns={[
        { key: "supplier", header: "Поставщик" },
        { key: "group", header: "Группа", width: 200 },
        { key: "status", header: "Подписка", width: 260 },
        { key: "paid", header: "Оплачено до", width: 150 },
        { key: "card", header: "Карта", width: 110 },
      ]}
    >
      {rows.map((row) => (
        <tr key={row.id} {...rowLink(supplierPath(row.supplierId, "billing"))}>
          <td>
            <SupplierName row={row} />
          </td>
          <td>
            <GroupMark row={row} />
          </td>
          <td className="ac-text-body-s">
            {row.subscriptionStatus ? (
              SUPPLIER_SUBSCRIPTION_TEXT[row.subscriptionStatus]
            ) : (
              <Muted>нет</Muted>
            )}
          </td>
          <td className="ac-text-body-s nowrap">
            {row.periodEnd ? formatDay(row.periodEnd) : <Muted>—</Muted>}
          </td>
          <td className="ac-text-body-s nowrap">
            {row.cardMask ? `•••• ${row.cardMask}` : <Muted>нет</Muted>}
          </td>
        </tr>
      ))}
    </Table>
  );
}

// ------------------------------------------------------------ the history

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function History({
  query,
  set,
}: {
  query: URLSearchParams;
  set: (patch: Record<string, string | undefined>) => void;
}) {
  const fromDay = DATE.test(query.get("from") ?? "") ? query.get("from")! : "";
  const toDay = DATE.test(query.get("to") ?? "") ? query.get("to")! : "";
  const status = CHARGE_STATUSES.find((value) => value === query.get("status"));
  const kind = KINDS.find((value) => value === query.get("kind"));
  const supplierId = query.get("supplierId") ?? undefined;
  const filters = {
    from: fromDay ? dayStart(fromDay) : undefined,
    to: toDay ? dayStart(toDay, 1) : undefined,
    supplierId,
    status,
    kind,
  };
  const [sum, setSum] = useState<number | null>(null);
  const list = usePaged<AdminCharge>(async (cursor) => {
    const page = await apiClient.listAdminCharges({ query: { ...filters, limit: 50, cursor } });
    setSum(page.totalAmount);
    return { items: page.charges, total: page.total, nextCursor: page.nextCursor };
  }, JSON.stringify(filters));
  const supplier = useSupplierChoice(supplierId ?? null, list.items);
  const filtered = Boolean(fromDay || toDay || status || kind || supplierId);

  return (
    <>
      <div className="filters__group">
        <div className="filters">
          <Period from={fromDay} to={toDay} onChange={(patch) => set(patch)} />
          <SearchSelect
            compact
            label="Поставщик"
            value={supplier.value}
            onChange={(choice) => {
              supplier.remember(choice);
              set({ supplierId: choice?.id });
            }}
            search={supplierSearch}
            empty="Все"
          />
          <FilterSelect<AdminChargeStatus>
            label="Статус"
            value={status}
            options={CHARGE_STATUSES.map((value) => ({ value, label: CHARGE_STATUS_TEXT[value] }))}
            onChange={(next) => set({ status: next })}
          />
          <FilterSelect<SupplierChargeKind>
            label="Вид"
            value={kind}
            options={KINDS.map((value) => ({ value, label: CHARGE_KIND_TEXT[value] }))}
            onChange={(next) => set({ kind: next })}
          />
          <IconButton icon="refresh" label="Обновить" size={20} onClick={list.first.reload} />
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
            {sum !== null && list.items.length > 0 && <span>на сумму {amountText(sum)}</span>}
            {filtered && (
              <Button
                variant="text"
                size="s"
                onClick={() =>
                  navigateTo(withQuery(routePaths.billingPayments, { tab: "history" }))
                }
              >
                Сбросить фильтры
              </Button>
            )}
          </TableToolbar>
          {list.items.length === 0 ? (
            <EmptyState
              icon="creditCard"
              title={filtered ? "Списаний не найдено" : "Списаний пока не было"}
              text={filtered ? "Измените отборы" : undefined}
            />
          ) : (
            <Table
              label="История списаний"
              columns={[
                { key: "at", header: "Дата", width: 150 },
                { key: "supplier", header: "Поставщик" },
                { key: "amount", header: "Сумма", width: 112, numeric: true },
                { key: "period", header: "Период подписки", width: 190 },
                { key: "card", header: "Карта", width: 100 },
                { key: "kind", header: "Вид", width: 200 },
                { key: "status", header: "Статус", width: 250 },
              ]}
            >
              {list.items.map((row) => (
                <tr key={row.id} {...rowLink(supplierPath(row.supplier.id, "billing"))}>
                  <td className="ac-text-body-s nowrap">{formatMoment(row.at)}</td>
                  <td>
                    <RowTitle href={supplierPath(row.supplier.id, "billing")}>
                      {row.supplier.name}
                    </RowTitle>
                  </td>
                  <td className="num">{amountText(row.amount)}</td>
                  <td className="ac-text-body-s nowrap">
                    {formatDay(row.periodFrom)} — {formatDay(row.periodTo)}
                  </td>
                  <td className="ac-text-body-s nowrap">
                    {row.cardMask ? `•••• ${row.cardMask}` : <Muted>—</Muted>}
                  </td>
                  <td className="ac-text-body-s">
                    {CHARGE_KIND_TEXT[row.kind]}
                    {row.requestedBy && (
                      <Muted> · нажал {row.requestedBy.name ?? "сотрудник"}</Muted>
                    )}
                  </td>
                  <td className="ac-text-body-s">
                    <ChargeStatus row={row} />
                  </td>
                </tr>
              ))}
            </Table>
          )}
          <MoreOrders list={list} />
        </div>
      </LoadingContent>
    </>
  );
}

function ChargeStatus({ row }: { row: AdminCharge }) {
  return (
    <span className="billing-status">
      <StatusBadge kind="charge" status={row.status}>
        {CHARGE_STATUS_TEXT[row.status]}
      </StatusBadge>
      {row.declineReason && <Muted>{DECLINE_REASON_TEXT[row.declineReason]}</Muted>}
      {row.nextTryAt && <Muted>повтор {formatMoment(row.nextTryAt)}</Muted>}
    </span>
  );
}
