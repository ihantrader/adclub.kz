import type { AdminSupplierViewsResponse } from "@adclub/contracts";
import { EmptyState, LoadingContent, SkeletonList } from "@adclub/ui";
import type { ReactNode } from "react";
import { apiClient } from "../api";
import { StatusChips } from "../layout/filters";
import { AppLink, Table } from "../layout/layout";
import { routePaths, withQuery } from "../router";
import { useLoad } from "../use-load";
import { LoadError } from "../vehicles/shared";
import { useAddressFilters } from "./shared";
import { conversionCell, shortDay, VIEW_PERIODS, viewRangeOf } from "./views-words";
import { SupplierStatsSection } from "./SupplierStatsSection";
import { statsPeriodOf } from "./stats-words";

const number = (value: number) => value.toLocaleString("ru-RU");

const COLUMNS = [
  { key: "day", header: "День", width: 100 },
  { key: "club", header: "Участники клуба", width: 150, numeric: true },
  { key: "user", header: "Без клубного доступа", width: 150, numeric: true },
  { key: "guest", header: "Гости", width: 150, numeric: true },
  { key: "total", header: "Всего", width: 150, numeric: true },
  { key: "orders", header: "Заявки", width: 150, numeric: true },
  { key: "conversion", header: "Конверсия", width: 150, numeric: true },
];

function Figure({ label, value, note }: { label: string; value: ReactNode; note: ReactNode }) {
  return (
    <div className="rating-figure">
      <span className="rating-figure__label">{label}</span>
      <span className="rating-figure__value">{value}</span>
      <span className="rating-figure__note">{note}</span>
    </div>
  );
}

/**
 * A-SUP-03 «Просмотры и заявки» (TASK-070; texts are ours, waiting for
 * SCREENS): the period (7 / 30 / 90 days, `?period=`), four figures — views
 * by members of the club, all views, orders, conversion — and every day of
 * the period. The numbers are the server's (`GET /admin/suppliers/{id}/views`);
 * who looked is shown nowhere. The signal «Просмотров много, заявок мало»
 * opens this tab.
 */
export function SupplierViews({ supplierId }: { supplierId: string }) {
  const { query, set } = useAddressFilters();
  const range = viewRangeOf({
    period: query.get("period"),
    from: query.get("from"),
    to: query.get("to"),
  });
  const loaded = useLoad<AdminSupplierViewsResponse>(
    () =>
      apiClient.getAdminSupplierViews(
        { supplierId },
        { query: { from: range.from, to: range.to } },
      ),
    `supplier-views:${supplierId}:${range.from}:${range.to}`,
  );
  const views = loaded.data?.views;
  const days = views ? [...views.days].reverse() : [];
  const quiet = views !== undefined && views.total.total === 0 && views.total.orders === 0;
  return (
    <div className="detail-stack">
      <StatusChips<string>
        label="Период"
        value={range.days === null ? "signal" : String(range.days)}
        allLabel={null}
        chips={[
          ...VIEW_PERIODS.map((days) => ({
            value: String(days),
            label: `${String(days)} дней`,
            count: null,
          })),
          ...(range.days === null
            ? [
                {
                  value: "signal",
                  label: `${shortDay(range.from)}–${shortDay(range.to)}, как в сигнале`,
                  count: null,
                },
              ]
            : []),
        ]}
        onChange={(next) => {
          if (next === "signal") return;
          set({ period: next === "30" ? undefined : next, from: undefined, to: undefined });
        }}
      />
      {/* TASK-071: one period for the tab — the supplier's statistics and the views below. */}
      <SupplierStatsSection supplierId={supplierId} period={statsPeriodOf(range.days)} />
      <section className="section" aria-labelledby="views-head">
        <div className="section__head">
          <h2 id="views-head" className="section__title">
            Просмотры и заявки
          </h2>
        </div>
        <LoadError error={loaded.error} retry={loaded.reload} />
        <LoadingContent
          ready={views !== undefined}
          indicator={loaded.indicator}
          label="Загрузка"
          swapKey={`${range.from}:${range.to}`}
          skeleton={<SkeletonList rows={4} label="Загрузка" />}
        >
          {views && (
            <>
              <div className="rating-figures">
                <Figure
                  label="Просмотры участников клуба"
                  value={number(views.total.club)}
                  note="их и сравнивает сигнал"
                />
                <Figure
                  label="Все просмотры"
                  value={number(views.total.total)}
                  note={`без доступа ${number(views.total.user)} · гости ${number(views.total.guest)}`}
                />
                <Figure
                  label="Заявки"
                  value={number(views.total.orders)}
                  note="без тестовых заявок сотрудников"
                />
                <Figure
                  label="Конверсия"
                  value={conversionCell(views.total.conversion)}
                  note="заявки ÷ просмотры участников клуба"
                />
              </div>
              <p className="section__note">
                Один просмотр — одно предложение, один человек, один день (по Алматы). Сигнал
                «Просмотров много, заявок мало» сравнивает последние{" "}
                {number(views.signal.windowDays)} дней: от {number(views.signal.minViews)}{" "}
                просмотров участников клуба, конверсия ниже медианы ×{" "}
                {views.signal.ratio.toLocaleString("ru-RU")}, если таких поставщиков не меньше{" "}
                {number(views.signal.minSuppliers)} —{" "}
                <AppLink href={withQuery(routePaths.settings, { q: "views_signal" })}>
                  настройки
                </AppLink>
                .
              </p>
              {quiet ? (
                <EmptyState
                  compact
                  icon="history"
                  title="За этот период нет ни просмотров, ни заявок"
                />
              ) : (
                <Table label="Просмотры и заявки по дням" columns={COLUMNS}>
                  {days.map((entry) => (
                    <tr key={entry.day}>
                      <td className="ac-text-body-s nowrap">{shortDay(entry.day)}</td>
                      <td className="ac-text-body-s num">{number(entry.club)}</td>
                      <td className="ac-text-body-s num">{number(entry.user)}</td>
                      <td className="ac-text-body-s num">{number(entry.guest)}</td>
                      <td className="ac-text-body-s num">{number(entry.total)}</td>
                      <td className="ac-text-body-s num">{number(entry.orders)}</td>
                      <td className="ac-text-body-s num">{conversionCell(entry.conversion)}</td>
                    </tr>
                  ))}
                </Table>
              )}
            </>
          )}
        </LoadingContent>
      </section>
    </div>
  );
}
