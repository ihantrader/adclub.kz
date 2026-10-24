import type { AdminSupplierRatingResponse, ReviewStatusValue } from "@adclub/contracts";
import { Badge, EmptyState, Icon, LoadingContent, SkeletonList, TableToolbar } from "@adclub/ui";
import type { ReactNode } from "react";
import { apiClient } from "../api";
import { formatMoment } from "../format";
import { StatusChips } from "../layout/filters";
import { AppLink, Table } from "../layout/layout";
import { ReviewRows } from "../reviews/ReviewList";
import { useReviewList } from "../reviews/Reviews";
import { REVIEW_TABS } from "../reviews/review-words";
import { routePaths, withQuery } from "../router";
import { useLoad } from "../use-load";
import { LoadError } from "../vehicles/shared";
import {
  figuresText,
  formulaText,
  percentText,
  RATING_CAUSE_TEXT,
  ratingNumber,
  scoresWord,
  thresholdNumber,
} from "./rating-words";
import { MoreButton, useAddressFilters } from "./shared";

const HISTORY_COLUMNS = [
  { key: "at", header: "Когда", width: 150 },
  { key: "before", header: "Было" },
  { key: "after", header: "Стало" },
  { key: "cause", header: "Причина", width: 160 },
];

/** One side of a change: its star in `accent`, as everywhere (DESIGN 7.7). */
function Figures({ text }: { text: string }) {
  if (!text.startsWith("★ ")) return <>{text}</>;
  return (
    <span className="rating-line">
      <Icon name="star" size={16} filled />
      {text.slice(2)}
    </span>
  );
}

/** One figure of the rating: a big number, what it is, what it was counted from. */
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
 * A-SUP-03 «Рейтинг и отзывы» (TASK-050, TASK-080): four figures as cards
 * with big numbers — the rating (its star in `accent`, as everywhere), the
 * scores, the share of answers, the deadlines kept — each with the numbers
 * the server counted it from; «Как считается» folded across the width (the
 * formula with its version and weights, the settings); the latest changes;
 * and the reviews of the supplier in every state (TASK-049) by status.
 */
export function SupplierRating({ supplierId }: { supplierId: string }) {
  const loaded = useLoad<AdminSupplierRatingResponse>(
    () => apiClient.getAdminSupplierRating({ supplierId }),
    `supplier-rating:${supplierId}`,
  );
  const rating = loaded.data?.rating;
  return (
    <div className="detail-stack">
      <LoadError error={loaded.error} retry={loaded.reload} />
      <LoadingContent
        ready={rating !== undefined}
        indicator={loaded.indicator}
        label="Загрузка"
        skeleton={<SkeletonList rows={4} label="Загрузка" />}
      >
        {rating && (
          <>
            <section className="section" aria-labelledby="rating-head">
              <div className="section__head">
                <h2 id="rating-head" className="section__title">
                  Рейтинг
                </h2>
                {rating.low && (
                  <Badge tone="warning" icon="alertTriangle">
                    Ниже порога сигнала {thresholdNumber(rating.lowThreshold)}
                  </Badge>
                )}
              </div>
              <div className="rating-figures">
                <Figure
                  label="Рейтинг"
                  value={
                    rating.score === null ? (
                      "Новый"
                    ) : (
                      <span className="rating-figure__star">
                        <Icon name="star" size={24} filled />
                        {ratingNumber(rating.score)}
                      </span>
                    )
                  }
                  note={
                    rating.score === null
                      ? `Показывается от ${rating.rules.minReviews} ${scoresWord(rating.rules.minReviews)}; сейчас ${rating.reviews.count}`
                      : "из 5"
                  }
                />
                <Figure
                  label="Оценки"
                  value={rating.reviews.count.toLocaleString("ru-RU")}
                  note={
                    rating.reviews.average === null
                      ? "оценок нет"
                      : `средняя ${rating.reviews.average.toLocaleString("ru-RU", { maximumFractionDigits: 2 })}`
                  }
                />
                <Figure
                  label="Доля ответов"
                  value={rating.response.rate === null ? "—" : percentText(rating.response.rate)}
                  note={
                    rating.response.rate === null
                      ? "мало заявок для оценки"
                      : `ответил на ${rating.response.answered.toLocaleString("ru-RU")} из ${rating.response.required.toLocaleString("ru-RU")}`
                  }
                />
                <Figure
                  label="Соблюдение сроков"
                  value={rating.onTime.rate === null ? "—" : percentText(rating.onTime.rate)}
                  note={
                    rating.onTime.rate === null
                      ? "мало заявок для оценки"
                      : `в срок ${rating.onTime.kept.toLocaleString("ru-RU")} из ${rating.onTime.judged.toLocaleString("ru-RU")}`
                  }
                />
              </div>
              <p className="section__note">
                {rating.computedAt
                  ? `Пересчитан ${formatMoment(rating.computedAt)}`
                  : "Ещё не считался — пересчитается после первого события или ночной сверки"}
              </p>
              <details className="disclosure card rating-formula">
                <summary className="disclosure__summary">Как считается</summary>
                <p className="ac-text-body-s">{formulaText(rating.rules, rating.formulaVersion)}</p>
                <p className="ac-text-body-s ac-muted">
                  Веса, пороги и окно —{" "}
                  <AppLink href={withQuery(routePaths.settings, { q: "rating_" })}>
                    настройки группы «Рейтинг»
                  </AppLink>
                  ; новые значения применяются на ближайшей ночной сверке.
                </p>
              </details>
            </section>

            <section className="section" aria-labelledby="rating-history">
              <div className="section__head">
                <h2 id="rating-history" className="section__title">
                  История рейтинга
                </h2>
              </div>
              {rating.history.length === 0 ? (
                <EmptyState compact icon="history" title="Изменений пока нет" />
              ) : (
                <Table label="История рейтинга" columns={HISTORY_COLUMNS}>
                  {rating.history.map((entry) => (
                    <tr key={entry.id}>
                      <td className="ac-text-body-s nowrap">{formatMoment(entry.at)}</td>
                      <td className="ac-text-body-s ac-muted">
                        <Figures text={figuresText(entry.before)} />
                      </td>
                      <td className="ac-text-body-s">
                        <Figures text={figuresText(entry.after)} />
                      </td>
                      <td className="ac-text-body-s">{RATING_CAUSE_TEXT[entry.cause]}</td>
                    </tr>
                  ))}
                </Table>
              )}
            </section>
          </>
        )}
      </LoadingContent>

      <Reviews supplierId={supplierId} />
    </div>
  );
}

/**
 * The supplier's reviews in every state (TASK-049): the status as chips with
 * the server's counts (`?reviews=`), the rows of «Отзывы» (their own
 * decisions), «Показать ещё».
 */
function Reviews({ supplierId }: { supplierId: string }) {
  const { query, set } = useAddressFilters();
  const status = REVIEW_TABS.find((tab) => tab.status === query.get("reviews"))?.status;
  const { list, rows, changed, counts } = useReviewList({ supplierId, status });
  const all = counts ? Object.values(counts).reduce((sum, value) => sum + value, 0) : null;
  return (
    <section className="section" aria-labelledby="rating-reviews">
      <div className="section__head">
        <h2 id="rating-reviews" className="section__title">
          Отзывы
        </h2>
      </div>
      <StatusChips<ReviewStatusValue>
        label="Статус отзыва"
        value={status}
        allCount={all}
        chips={REVIEW_TABS.map((tab) => ({
          value: tab.status,
          label: tab.label,
          count: counts ? counts[tab.status] || null : null,
        }))}
        onChange={(next) => set({ reviews: next })}
      />
      <LoadError error={list.first.error} retry={list.first.reload} />
      <LoadingContent
        ready={list.first.data !== undefined}
        indicator={list.first.indicator}
        label="Загрузка"
        swapKey={list.first.answerKey}
        skeleton={<SkeletonList rows={4} label="Загрузка" />}
      >
        <div className="list-block">
          <TableToolbar total={rows.length === 0 ? null : list.total} />
          {rows.length === 0 ? (
            <EmptyState
              compact
              icon="star"
              title={status ? "Таких отзывов нет" : "Отзывов пока нет"}
              text={status ? undefined : "Отзывы оставляют по выданным заявкам"}
            />
          ) : (
            <ReviewRows reviews={rows} onChanged={changed} hide={["supplier"]} />
          )}
          <MoreButton list={list} />
        </div>
      </LoadingContent>
    </section>
  );
}
