import type { SupplierStatsPeriod } from "@adclub/contracts";

/** A share of the statistics: «75 %», or «Мало заявок для оценки» (as M-CAT-09 and the cabinet). */
export function shareCell(percent: number | null): string {
  return percent === null ? "Мало заявок для оценки" : `${String(percent)} %`;
}

/** The rating shown now: «4,6», or «Новый поставщик». */
export function statsRatingText(score: number | null): string {
  return score === null
    ? "Новый поставщик"
    : score.toLocaleString("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/** The period of the statistics for the tab's: 7 / 30 / 90, the signal's own window — 30. */
export function statsPeriodOf(days: number | null): SupplierStatsPeriod {
  return days === 7 ? "7" : days === 90 ? "90" : "30";
}
