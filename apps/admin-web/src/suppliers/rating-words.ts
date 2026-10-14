import type {
  AdminSupplierListRating,
  SupplierRatingFigures,
  SupplierRatingFilter,
  SupplierRatingRules,
} from "@adclub/contracts";

/**
 * The words of the rating of a supplier (TASK-050; SCREENS A-SUP-02,
 * A-SUP-03): what the server counted, said in plain Russian. Nothing is
 * counted here — the rating, the shares and «низкий» are the server's.
 */

/** «4,3». */
export function ratingNumber(value: number): string {
  return value.toLocaleString("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/** The threshold of the signal, a setting with up to two decimals: «3,5», «4,35». */
export function thresholdNumber(value: number): string {
  return value.toLocaleString("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 2 });
}

/** A row of A-SUP-02: «★ 4,3 (5)», «новый · 3 оценки» or «новый». */
export function listRatingText(rating: AdminSupplierListRating | null): string {
  if (!rating || rating.value === null) {
    return rating && rating.count > 0 ? `новый · оценок ${rating.count}` : "новый";
  }
  return `★ ${ratingNumber(rating.value)} (${rating.count})`;
}

export const RATING_FILTER_TEXT: Record<SupplierRatingFilter, string> = {
  low: "Ниже порога сигнала",
  new: "Новые (без рейтинга)",
  rated: "С рейтингом",
};

/** A share: «90 %» (rounded down, as the app shows it), `null` — «мало заявок». */
export function percentText(rate: number | null): string {
  return rate === null ? "мало заявок для оценки" : `${Math.floor(rate * 100 + 1e-9)} %`;
}

/** «ответил на 45 из 50 (90 %)». */
export function partText(done: number, of: number, rate: number | null, verb: string): string {
  return `${verb} ${done.toLocaleString("ru-RU")} из ${of.toLocaleString("ru-RU")} (${percentText(rate)})`;
}

/** The formula with the weights it was counted by. */
export function formulaText(rules: SupplierRatingRules, version: number): string {
  const weight = (value: number) => value.toLocaleString("ru-RU", { maximumFractionDigits: 3 });
  return (
    `${weight(rules.weights.reviews)} × средняя оценка + ${weight(rules.weights.response_rate)} × доля ответов + ` +
    `${weight(rules.weights.deadline_rate)} × соблюдение сроков (доля в звёздах: 1 + 4 × доля); ` +
    `версия формулы ${version}. Рейтинг — от ${rules.minReviews} оценок, доля — от ${rules.minOrders} заявок, ` +
    `окно ${rules.windowDays} дн. Доля, где заявок меньше, в рейтинг не входит — её вес делится между остальными.`
  );
}

/** One side of a change of the history: «★ 4,3 (5), ответы 80 %, сроки 100 %» or «новый (3 оценки)». */
export function figuresText(figures: SupplierRatingFigures): string {
  const head =
    figures.score === null
      ? `новый (оценок ${figures.reviewsCount})`
      : `★ ${ratingNumber(figures.score)} (${figures.reviewsCount})`;
  return `${head}, ответы ${percentText(figures.responseRate)}, сроки ${percentText(figures.onTimeRate)}`;
}

export const RATING_CAUSE_TEXT: Record<"event" | "reconcile", string> = {
  event: "после события",
  reconcile: "ночная сверка",
};
