import type { DashboardOutput, PartPhotoOutput } from "../ai";
import { dashboardAnswer } from "../garage";
import { digitReading, partArticles } from "../showcase";
import type { DashboardEvalSample, PartEvalSample } from "./photo-eval-data";

/**
 * How the answers of one model on a synthetic set of TASK-058 are scored
 * (D-058). Pure — the runner collects answers, this counts. An answer is
 * scored as the server would pass it on: the dashboard through
 * `dashboardAnswer` (miles to kilometres, nothing out of range), a part
 * through `partArticles` (normal form, no barcode).
 *
 * The thresholds (TASK-058): the dashboard — the exact number on the
 * readable panels ≥ 95 %, «не панель» refused ≥ 95 %; a part — the exact
 * article on the readable labels ≥ 90 %, a false article ≤ 5 %.
 */

export const DASHBOARD_THRESHOLD = { value: 0.95, refusal: 0.95 } as const;
export const PART_THRESHOLD = { article: 0.9, falseArticle: 0.05 } as const;

export interface Share {
  correct: number;
  total: number;
  share: number;
}

function share(correct: number, total: number): Share {
  return { correct, total, share: total === 0 ? 1 : Math.round((correct / total) * 1000) / 1000 };
}

export interface Miss {
  sampleId: string;
  what: string;
  expected: string;
  got: string;
}

export interface DashboardScore {
  /** The exact kilometres on the readable panels. */
  value: Share;
  /** «Не панель» answered as anything but a reading. */
  refusal: Share;
  /** A number on a panel that could not be read, other than the hidden one. */
  falseValues: Share;
  /** The number under a thumb or a blur, answered anyway. */
  guessedHidden: number;
  passes: boolean;
  misses: Miss[];
}

export function scoreDashboards(
  samples: readonly DashboardEvalSample[],
  answers: ReadonlyMap<string, DashboardOutput>,
): DashboardScore {
  let valueOk = 0;
  let valueTotal = 0;
  let refused = 0;
  let refusalTotal = 0;
  let falseValues = 0;
  let unreadableTotal = 0;
  let guessedHidden = 0;
  const misses: Miss[] = [];
  for (const sample of samples) {
    const output = answers.get(sample.id);
    const answer = output ? dashboardAnswer(output) : null;
    const got = answer
      ? `${answer.kind} ${answer.mileageKm ?? "-"} ${answer.unit ?? ""}`.trim()
      : "нет ответа";
    if (sample.expected.kind === "not_dashboard") {
      refusalTotal += 1;
      if (answer && answer.kind !== "dashboard") refused += 1;
      else misses.push({ sampleId: sample.id, what: "не панель", expected: "отказ", got });
      continue;
    }
    if (!sample.readable) {
      unreadableTotal += 1;
      if (answer?.kind === "dashboard") {
        if (sample.hiddenKm !== undefined && answer.mileageKm === sample.hiddenKm)
          guessedHidden += 1;
        else {
          falseValues += 1;
          misses.push({
            sampleId: sample.id,
            what: "ложное значение",
            expected: "не читается",
            got,
          });
        }
      }
      continue;
    }
    valueTotal += 1;
    if (answer?.kind === "dashboard" && answer.mileageKm === sample.expected.mileageKm) {
      valueOk += 1;
    } else {
      misses.push({
        sampleId: sample.id,
        what: "пробег",
        expected: `${sample.expected.mileageKm} км`,
        got,
      });
    }
  }
  const value = share(valueOk, valueTotal);
  const refusal = share(refused, refusalTotal);
  return {
    value,
    refusal,
    falseValues: share(falseValues, unreadableTotal),
    guessedHidden,
    passes:
      value.share >= DASHBOARD_THRESHOLD.value && refusal.share >= DASHBOARD_THRESHOLD.refusal,
    misses,
  };
}

export interface PartScore {
  /** The part's own article first, exactly, on the readable labels. */
  article: Share;
  /** The second article of a label with two, found among the answer's. */
  secondArticle: Share;
  /** An answer whose first article is not an article of the label (none, a barcode, a batch). */
  falseArticle: Share;
  /** Labels without an article answered without one. */
  noArticle: Share;
  /** The article under a thumb or a blur, answered anyway. */
  guessedHidden: number;
  passes: boolean;
  misses: Miss[];
}

export function scoreParts(
  samples: readonly PartEvalSample[],
  answers: ReadonlyMap<string, PartPhotoOutput>,
): PartScore {
  let articleOk = 0;
  let articleTotal = 0;
  let secondOk = 0;
  let secondTotal = 0;
  let falseArticles = 0;
  let answered = 0;
  let noArticleOk = 0;
  let noArticleTotal = 0;
  let guessedHidden = 0;
  const misses: Miss[] = [];
  for (const sample of samples) {
    const output = answers.get(sample.id);
    if (!output) continue;
    answered += 1;
    const read = partArticles(output).map((article) => article.normalized);
    const first = read[0] ?? null;
    const got = read.length === 0 ? output.kind : read.join(", ");
    const printed = new Set(sample.expected.articles);
    if (sample.hiddenArticle) printed.add(sample.hiddenArticle);
    const asDigits = first === null ? null : digitReading(first);
    const isPrinted = (value: string | null) =>
      value !== null &&
      (printed.has(value) || (digitReading(value) !== null && printed.has(digitReading(value)!)));
    if (first !== null && !isPrinted(first)) {
      falseArticles += 1;
      misses.push({
        sampleId: sample.id,
        what: "ложный артикул",
        expected: sample.expected.articles.join(", ") || "нет",
        got,
      });
    }
    if (sample.expected.articles.length === 0 && sample.hiddenArticle === undefined) {
      noArticleTotal += 1;
      if (first === null) noArticleOk += 1;
      continue;
    }
    if (!sample.readable) {
      if (first !== null && first === sample.hiddenArticle) guessedHidden += 1;
      continue;
    }
    articleTotal += 1;
    const want = sample.expected.articles[0]!;
    if (first === want || asDigits === want) articleOk += 1;
    else if (isPrinted(first)) {
      misses.push({ sampleId: sample.id, what: "не тот артикул первым", expected: want, got });
    } else if (first === null) {
      misses.push({ sampleId: sample.id, what: "артикул", expected: want, got });
    }
    const second = sample.expected.articles[1];
    if (second !== undefined) {
      secondTotal += 1;
      if (read.includes(second)) secondOk += 1;
    }
  }
  const article = share(articleOk, articleTotal);
  const falseArticle = share(falseArticles, answered);
  return {
    article,
    secondArticle: share(secondOk, secondTotal),
    falseArticle,
    noArticle: share(noArticleOk, noArticleTotal),
    guessedHidden,
    passes:
      article.share >= PART_THRESHOLD.article && falseArticle.share <= PART_THRESHOLD.falseArticle,
    misses,
  };
}
