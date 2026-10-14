import type { AdminSupplierRatingResponse } from "@adclub/contracts";
import { EmptyState, LoadingContent, SkeletonList } from "@adclub/ui";
import { apiClient } from "../api";
import { formatMoment } from "../format";
import { SupplierReviews } from "../reviews/Blocks";
import { routePaths, withQuery } from "../router";
import { AppLink } from "../catalog/shared";
import { useLoad } from "../use-load";
import { LoadError } from "../vehicles/shared";
import {
  figuresText,
  formulaText,
  partText,
  RATING_CAUSE_TEXT,
  ratingNumber,
  thresholdNumber,
} from "./rating-words";

/**
 * A-SUP-03 «Рейтинг и отзывы» (TASK-050): the rating and its three parts with
 * the numbers the server counted them from, the formula with its version and
 * weights, when it was counted, the latest changes — and the reviews of the
 * supplier in every state (TASK-049) below.
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
            <section className="card-section" aria-labelledby="rating-head">
              <h2 id="rating-head" className="ac-text-heading">
                Рейтинг
              </h2>
              <p className="ac-text-title-l">
                {rating.score === null ? "Новый поставщик" : `★ ${ratingNumber(rating.score)}`}
                {rating.low && (
                  <span className="ac-text-body-s rating-low">
                    {" "}
                    · ниже порога сигнала {thresholdNumber(rating.lowThreshold)}
                  </span>
                )}
              </p>
              {rating.score === null && (
                <p className="ac-text-body-s ac-muted">
                  Рейтинг показывается от {rating.rules.minReviews} опубликованных оценок; сейчас{" "}
                  {rating.reviews.count}.
                </p>
              )}
              <dl className="facts">
                <div>
                  <dt>Оценки</dt>
                  <dd className="num">
                    {rating.reviews.count === 0
                      ? "оценок нет"
                      : `${rating.reviews.count.toLocaleString("ru-RU")}, средняя ${rating.reviews.average?.toLocaleString("ru-RU", { maximumFractionDigits: 2 }) ?? "—"}`}
                  </dd>
                </div>
                <div>
                  <dt>Доля ответов</dt>
                  <dd className="num">
                    {partText(
                      rating.response.answered,
                      rating.response.required,
                      rating.response.rate,
                      "ответил на",
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Соблюдение сроков</dt>
                  <dd className="num">
                    {partText(
                      rating.onTime.kept,
                      rating.onTime.judged,
                      rating.onTime.rate,
                      "в срок",
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Формула</dt>
                  <dd>{formulaText(rating.rules, rating.formulaVersion)}</dd>
                </div>
                <div>
                  <dt>Пересчитан</dt>
                  <dd>
                    {rating.computedAt
                      ? formatMoment(rating.computedAt)
                      : "ещё не считался — пересчитается после первого события или ночной сверки"}
                  </dd>
                </div>
              </dl>
              <p className="ac-text-body-s ac-muted">
                Веса, пороги и окно —{" "}
                <AppLink href={withQuery(routePaths.settings, { q: "rating_" })}>
                  настройки группы «Рейтинг»
                </AppLink>
                ; новые значения применяются на ближайшей ночной сверке.
              </p>
            </section>

            <section className="card-section" aria-labelledby="rating-history">
              <h2 id="rating-history" className="ac-text-heading">
                История рейтинга
              </h2>
              {rating.history.length === 0 ? (
                <EmptyState icon="clock" title="Изменений пока нет" text="" />
              ) : (
                <div className="table-wrap">
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th scope="col">Когда</th>
                        <th scope="col">Было</th>
                        <th scope="col">Стало</th>
                        <th scope="col">Причина</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rating.history.map((entry) => (
                        <tr key={entry.id}>
                          <td className="num">{formatMoment(entry.at)}</td>
                          <td>{figuresText(entry.before)}</td>
                          <td>{figuresText(entry.after)}</td>
                          <td>{RATING_CAUSE_TEXT[entry.cause]}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
      </LoadingContent>

      <section className="card-section" aria-labelledby="rating-reviews">
        <h2 id="rating-reviews" className="ac-text-heading">
          Отзывы
        </h2>
        <SupplierReviews supplierId={supplierId} />
      </section>
    </div>
  );
}
