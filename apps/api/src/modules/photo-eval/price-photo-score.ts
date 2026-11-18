import {
  agreePricePhotoPages,
  normalizeArticle,
  priceNameKey,
  pricePhotoPage,
} from "@adclub/domain";
import type { PricePhotoOutput } from "../ai";
import type { PricePhotoEvalSample } from "./photo-eval-data";
import type { Miss, Share } from "./photo-eval-score";

/**
 * How the answers of one model on the photographed price pages of TASK-064
 * are scored (D-058). An answer is scored as the worker would keep it —
 * through `pricePhotoPage` of the domain (cleaned, rows with nothing to
 * import dropped, an empty list is «нет таблицы»).
 *
 * A row of a page is found among the model's rows by its article (normal
 * form), a row without an article by its name (`priceNameKey`). Counted:
 * - `exact` — rows of the readable pages read with the very article and price;
 * - `missed` — rows of the readable pages the model left out (or misread the
 *   article of, which is the same for the import);
 * - `falseRows` — rows the model gave that are on no page: a misread article,
 *   an invented row, any row of a page that is no price list or can't be read;
 * - `refusal` — the page without a table answered without rows;
 * - `silentErrors` — a wrong price not marked uncertain: what the supplier
 *   would not be warned of (the doubt flag is what makes a photo safe).
 *
 * The threshold (TASK-064, ARCHITECTURE 4.93): exact ≥ 95 % of the rows,
 * false rows ≤ 2 % of the rows the model gave, «не таблица» refused on
 * every such page.
 */

export const PRICE_PHOTO_THRESHOLD = { exact: 0.95, falseRows: 0.02, refusal: 1 } as const;

export interface PricePhotoScore {
  exact: Share;
  missed: number;
  falseRows: Share;
  refusal: Share;
  /** Rows under a stain or a correction marked uncertain, of such rows read. */
  doubtMarked: Share;
  silentErrors: number;
  passes: boolean;
  misses: Miss[];
}

function share(correct: number, total: number): Share {
  return { correct, total, share: total === 0 ? 1 : Math.round((correct / total) * 1000) / 1000 };
}

function keyOf(article: string | null, name: string | null): string | null {
  if (article) {
    const norm = normalizeArticle(article);
    if (norm) return `a:${norm}`;
  }
  if (name) return `n:${priceNameKey(name)}`;
  return null;
}

/**
 * The page as the worker keeps it, said again as a model's answer: the
 * first reading checked by `pricePhotoPage`, agreed with the second one
 * (`agreePricePhotoPages`) — so the comparison scores what the supplier
 * would see, not one raw answer.
 */
export function keptPricePhoto(outputs: readonly PricePhotoOutput[]): PricePhotoOutput {
  const first = pricePhotoPage(outputs[0]!);
  const kept =
    outputs.length > 1 ? agreePricePhotoPages(first, pricePhotoPage(outputs[1]!)) : first;
  if (kept.kind === "unreadable") return { kind: "unreadable", rows: [] };
  if (kept.kind === "no_table") return { kind: "not_a_table", rows: [] };
  return {
    kind: "price_list",
    rows: kept.rows.map((row) => ({
      text: row.text,
      article: row.cells[0] as string | null,
      brand: row.cells[1] as string | null,
      name: row.cells[2] as string | null,
      price: row.cells[3] as number | null,
      availability: row.cells[4] as string | null,
      leadTime: row.cells[5] as string | null,
      uncertain: row.uncertain,
    })),
  };
}

export function scorePricePhotos(
  samples: readonly PricePhotoEvalSample[],
  answers: ReadonlyMap<string, PricePhotoOutput>,
): PricePhotoScore {
  let exact = 0;
  let expectedRows = 0;
  let missed = 0;
  let returnedRows = 0;
  let falseRows = 0;
  let refused = 0;
  let refusalTotal = 0;
  let doubtful = 0;
  let doubtMarked = 0;
  let silentErrors = 0;
  const misses: Miss[] = [];
  for (const sample of samples) {
    const output = answers.get(sample.id);
    const page = output ? pricePhotoPage(output) : null;
    const rows = page?.kind === "rows" ? page.rows : [];
    returnedRows += rows.length;
    if (sample.expected.kind !== "price_list") {
      if (sample.expected.kind === "not_a_table") {
        refusalTotal += 1;
        if (rows.length === 0) refused += 1;
        else
          misses.push({
            sampleId: sample.id,
            what: "не таблица",
            expected: "без строк",
            got: `${String(rows.length)} строк`,
          });
      }
      falseRows += rows.length;
      continue;
    }
    const byKey = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const key = keyOf(row.cells[0] as string | null, row.cells[2] as string | null);
      if (key && !byKey.has(key)) byKey.set(key, row);
    }
    const used = new Set<string>();
    for (const expected of sample.expected.rows) {
      expectedRows += 1;
      const key = keyOf(expected.article, expected.name);
      const found = key ? byKey.get(key) : undefined;
      if (!found || !key) {
        missed += 1;
        misses.push({
          sampleId: sample.id,
          what: "строка",
          expected: `${expected.article ?? expected.name} ${String(expected.price)}`,
          got: "нет",
        });
        continue;
      }
      used.add(key);
      const price = found.cells[3];
      const priceOk = typeof price === "number" && Math.round(price) === expected.price;
      const unsure = found.uncertain.length > 0;
      if (expected.uncertainPrice) {
        doubtful += 1;
        if (unsure) doubtMarked += 1;
      }
      if (priceOk) {
        exact += 1;
      } else {
        if (!unsure) silentErrors += 1;
        misses.push({
          sampleId: sample.id,
          what: unsure ? "цена (помечена неуверенной)" : "цена",
          expected: String(expected.price),
          got: String(price),
        });
      }
    }
    for (const [key, row] of byKey) {
      if (used.has(key)) continue;
      falseRows += 1;
      misses.push({ sampleId: sample.id, what: "лишняя строка", expected: "—", got: row.text });
    }
    // Rows with neither an article nor a name, or a second row with one key: false too.
    falseRows += rows.length - byKey.size;
  }
  const exactShare = share(exact, expectedRows);
  const falseShare = share(falseRows, returnedRows);
  const refusalShare = share(refused, refusalTotal);
  return {
    exact: exactShare,
    missed,
    falseRows: falseShare,
    refusal: refusalShare,
    doubtMarked: share(doubtMarked, doubtful),
    silentErrors,
    passes:
      exactShare.share >= PRICE_PHOTO_THRESHOLD.exact &&
      falseShare.share <= PRICE_PHOTO_THRESHOLD.falseRows &&
      refusalShare.share >= PRICE_PHOTO_THRESHOLD.refusal,
    misses,
  };
}
