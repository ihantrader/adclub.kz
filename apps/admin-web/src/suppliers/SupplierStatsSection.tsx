import type { SupplierStatsPeriod, SupplierStatsResponse } from "@adclub/contracts";
import { LoadingContent, SkeletonList } from "@adclub/ui";
import type { ReactNode } from "react";
import { apiClient } from "../api";
import { useLoad } from "../use-load";
import { LoadError } from "../vehicles/shared";
import { shortDay } from "./views-words";
import { shareCell, statsRatingText } from "./stats-words";

const number = (value: number) => value.toLocaleString("ru-RU");

function Figure({ label, value, note }: { label: string; value: string; note: ReactNode }) {
  // A word in place of a number — «Мало заявок для оценки», «Новый поставщик».
  const word = !/\d/.test(value);
  return (
    <div className="rating-figure">
      <span className="rating-figure__label">{label}</span>
      <span
        className={
          word ? "rating-figure__value rating-figure__value--text" : "rating-figure__value"
        }
      >
        {value}
      </span>
      <span className="rating-figure__note">{note}</span>
    </div>
  );
}

/**
 * «Статистика, как её видит поставщик» (TASK-071; S-STAT-01): the very count
 * of the cabinet's «Статистика» (`GET /admin/suppliers/{id}/stats` — the
 * same function as `GET /supplier/stats`) for the period of the tab. The
 * administrator sees what the supplier sees, nothing more.
 */
export function SupplierStatsSection({
  supplierId,
  period,
}: {
  supplierId: string;
  period: SupplierStatsPeriod;
}) {
  const loaded = useLoad<SupplierStatsResponse>(
    () => apiClient.getAdminSupplierStats({ supplierId }, { query: { period } }),
    `supplier-stats:${supplierId}:${period}`,
  );
  const stats = loaded.data?.stats;
  return (
    <section className="section" aria-labelledby="stats-head">
      <div className="section__head">
        <h2 id="stats-head" className="section__title">
          Статистика, как её видит поставщик
        </h2>
      </div>
      <LoadError error={loaded.error} retry={loaded.reload} />
      <LoadingContent
        ready={stats !== undefined}
        indicator={loaded.indicator}
        label="Загрузка"
        swapKey={period}
        skeleton={<SkeletonList rows={2} label="Загрузка" />}
      >
        {stats && (
          <>
            <div className="rating-figures">
              <Figure
                label="Заявки"
                value={number(stats.orders.total)}
                note={`выдано ${number(stats.orders.completed)} · отменено клиентами ${number(stats.orders.cancelledByUser)} · отклонено ${number(stats.orders.declinedBySupplier)} · истекло без ответа ${number(stats.orders.expiredNoResponse)}`}
              />
              <Figure
                label="Доля ответов"
                value={shareCell(stats.shares.responsePercent)}
                note={
                  stats.shares.responsePercent === null
                    ? `нужно не меньше ${number(stats.shares.minOrders)} заявок`
                    : `вовремя ${number(stats.shares.answered)} из ${number(stats.shares.answerRequired)}`
                }
              />
              <Figure
                label="Соблюдение сроков"
                value={shareCell(stats.shares.onTimePercent)}
                note={
                  stats.shares.onTimePercent === null
                    ? `нужно не меньше ${number(stats.shares.minOrders)} заявок`
                    : `в срок ${number(stats.shares.kept)} из ${number(stats.shares.judged)}`
                }
              />
              <Figure
                label="Рейтинг"
                value={statsRatingText(stats.rating.score)}
                note={`оценок ${number(stats.rating.reviewsCount)} · окно рейтинга ${number(stats.rating.windowDays)} дней`}
              />
            </div>
            <p className="section__note">
              Заявки, оформленные с {shortDay(stats.from)} по {shortDay(stats.to)} (по Алматы);
              просмотры предложений — {number(stats.views.total)}, из них участники клуба —{" "}
              {number(stats.views.club)}. Тестовые заказы не учитываются.
            </p>
          </>
        )}
      </LoadingContent>
    </section>
  );
}
