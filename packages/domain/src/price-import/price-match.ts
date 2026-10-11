import { normalizeArticle } from "../article/normalize-article";

/**
 * Matching the rows of a price list with the catalog (TASK-047; ARCHITECTURE
 * 12.1 step 4, 4.67): the rules the worker decides a row by before AI is
 * asked, and the ones the review and the application use. Pure functions —
 * the worker and the tests call exactly these.
 */

/** What a row of the file is remembered and recognised by: its article, or — without one — its name. */
export type PriceRowKeyKind = "article" | "name";

export interface PriceRowKey {
  kind: PriceRowKeyKind;
  key: string;
}

/** Words a name is made of no matter how it is written: lower case, «ё» as «е», no punctuation. */
export function priceNameKey(name: string): string {
  return nameTokens(name).join(" ");
}

/**
 * The key of a row (12.2): the normalized article; a row without an article
 * is known by its normalized name — less reliable, the cabinet warns about
 * it. `null` — the row has neither (it is an error row already).
 */
export function priceRowKey(row: {
  articleNorm: string | null;
  name: string | null;
}): PriceRowKey | null {
  if (row.articleNorm) return { kind: "article", key: row.articleNorm };
  const name = row.name ? priceNameKey(row.name) : "";
  return name === "" ? null : { kind: "name", key: name };
}

/**
 * The rows that repeat an earlier row of the same file (requirement 6): the
 * first row with a key decides, every later one is «повтор строки N».
 * Returns the later rows with the number of the first one.
 */
export function repeatedRows(
  rows: readonly { rowNo: number; key: PriceRowKey | null }[],
): Map<number, number> {
  const first = new Map<string, number>();
  const repeated = new Map<number, number>();
  for (const row of [...rows].sort((a, b) => a.rowNo - b.rowNo)) {
    if (!row.key) continue;
    const id = `${row.key.kind}:${row.key.key}`;
    const seen = first.get(id);
    if (seen === undefined) first.set(id, row.rowNo);
    else repeated.set(row.rowNo, seen);
  }
  return repeated;
}

// ------------------------------------------------------------ exact article

export interface ArticleItem {
  itemId: string;
  brandId: string | null;
}

export type ExactArticleDecision =
  | { kind: "confident"; itemId: string }
  | { kind: "review"; itemIds: string[]; reason: "several_brands" | "other_brand" }
  | { kind: "none" };

/**
 * Step 2 of matching: the items with the row's article (active items of
 * visible subcategories the company may sell). The brand of the row by any
 * of its spellings (`rowBrandIds` — the brands it names, empty when it
 * names none or none is known) picks one; without a brand only a single
 * item with the article is sure. Several items the brand doesn't decide
 * between — the supplier chooses; a known brand that has no item with the
 * article — the supplier checks the item that has it.
 */
export function exactArticleDecision(
  items: readonly ArticleItem[],
  rowBrandIds: readonly string[],
): ExactArticleDecision {
  if (items.length === 0) return { kind: "none" };
  if (rowBrandIds.length > 0) {
    const brands = new Set(rowBrandIds);
    const same = items.filter((item) => item.brandId !== null && brands.has(item.brandId));
    if (same.length === 1) return { kind: "confident", itemId: same[0]!.itemId };
    if (same.length > 1) {
      return { kind: "review", itemIds: same.map((item) => item.itemId), reason: "several_brands" };
    }
    return { kind: "review", itemIds: items.map((item) => item.itemId), reason: "other_brand" };
  }
  if (items.length === 1) return { kind: "confident", itemId: items[0]!.itemId };
  return { kind: "review", itemIds: items.map((item) => item.itemId), reason: "several_brands" };
}

// ------------------------------------------------------------- the name

/** Units a number in a name is written together with («4л», «500мл»). */
const UNITS = new Set([
  "л",
  "мл",
  "кг",
  "г",
  "гр",
  "шт",
  "мм",
  "см",
  "м",
  "в",
  "вт",
  "ач",
  "l",
  "ml",
  "kg",
  "g",
  "mm",
  "cm",
  "m",
  "pcs",
  "v",
  "w",
  "ah",
]);

/** Words that say nothing about which item it is. */
const STOP_WORDS = new Set([
  "для",
  "под",
  "без",
  "или",
  "with",
  "for",
  "and",
  "the",
  "үшін",
  "және",
  "арт",
  "код",
]);

/**
 * The tokens of a text: lower case, «ё» as «е», a hyphen or a slash inside a
 * word joins it («5W-30» — `5w30`, «04465-0K090» — `044650k090`), a decimal
 * comma is a point, a number written with its unit is two tokens («4л» —
 * `4`, `л`).
 */
export function nameTokens(text: string): string[] {
  const plain = text
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/(?<=\d),(?=\d)/g, ".")
    .replace(/(?<=[\p{L}\p{N}])[-–/](?=[\p{L}\p{N}])/gu, "");
  const tokens: string[] = [];
  for (const raw of plain.split(/[^\p{L}\p{N}.]+/u)) {
    const token = raw.replace(/^\.+|\.+$/g, "");
    if (token === "") continue;
    const unit = /^(\d+(?:\.\d+)?)(\p{L}{1,3})$/u.exec(token);
    if (unit && UNITS.has(unit[2]!)) {
      tokens.push(unit[1]!, unit[2]!);
    } else {
      tokens.push(token);
    }
  }
  return tokens;
}

interface Reading {
  /** Words without digits, three letters and longer, without stop words. */
  words: string[];
  /** Tokens with a digit: sizes, volumes, grades, codes — what tells items of one line apart. */
  marks: string[];
}

function readingOf(text: string): Reading {
  const words: string[] = [];
  const marks: string[] = [];
  for (const token of nameTokens(text)) {
    if (/\d/.test(token)) marks.push(token);
    else if (token.length >= 3 && !STOP_WORDS.has(token)) words.push(token);
  }
  return { words, marks };
}

/** Two words are the same word in another form: equal, or sharing all but a short ending. */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const shorter = Math.min(a.length, b.length);
  if (shorter < 4) return false;
  let common = 0;
  while (common < shorter && a[common] === b[common]) common++;
  return common >= Math.max(4, shorter - 2);
}

function hasWord(words: readonly string[], word: string): boolean {
  return words.some((other) => sameWord(other, word));
}

/** A catalog item as matching sees it. */
export interface NameCandidate {
  itemId: string;
  /** The name of the item (Russian, or whatever text the catalog has). */
  name: string;
  /** The brand's spellings; empty — no brand. */
  brandSpellings: readonly string[];
  article: string | null;
  /**
   * Words that describe the item without being its name — the subcategory
   * and its node («Моторные масла», «Масла и жидкости»): a row saying
   * «масло моторное» says nothing beyond them.
   */
  context?: string;
}

/** A row of the file as matching sees it. */
export interface NameRow {
  name: string | null;
  brand: string | null;
  /** The row's article (`normalizeArticle`); another article of the item means another item. */
  articleNorm?: string | null;
}

/**
 * How well a candidate fits a row, 0…1: the share of the candidate's words
 * and marks found in the row, and of the row's in the candidate, averaged.
 * Orders the candidates handed to AI and shown to the supplier.
 */
export function candidateScore(row: NameRow, candidate: NameCandidate): number {
  const rowReading = readingOf(`${row.name ?? ""} ${row.brand ?? ""}`);
  const own = readingOf(
    `${candidate.name} ${candidate.brandSpellings[0] ?? ""} ${candidate.article ?? ""}`,
  );
  const rowTerms = [...rowReading.words, ...rowReading.marks];
  const ownTerms = [...own.words, ...own.marks];
  if (rowTerms.length === 0 || ownTerms.length === 0) return 0;
  const inRow = ownTerms.filter((term) =>
    /\d/.test(term) ? rowReading.marks.includes(term) : hasWord(rowReading.words, term),
  ).length;
  const inOwn = rowTerms.filter((term) =>
    /\d/.test(term) ? own.marks.includes(term) : hasWord(own.words, term),
  ).length;
  return (inRow / ownTerms.length + inOwn / rowTerms.length) / 2;
}

/** The candidates in the order of `candidateScore`, the best `limit` with a score above zero. */
export function rankCandidates<Candidate extends NameCandidate>(
  row: NameRow,
  candidates: readonly Candidate[],
  limit: number,
): { candidate: Candidate; score: number }[] {
  return candidates
    .map((candidate) => ({ candidate, score: candidateScore(row, candidate) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.candidate.itemId.localeCompare(b.candidate.itemId))
    .slice(0, limit);
}

function brandFits(row: NameRow, candidate: NameCandidate, rowTokens: readonly string[]): boolean {
  if (candidate.brandSpellings.length === 0) return true;
  return candidate.brandSpellings.some((spelling) => {
    const brand = nameTokens(spelling);
    return brand.length > 0 && brand.every((token) => rowTokens.includes(token));
  });
}

/**
 * Whether a candidate is a sure match of a row by its name (step 3, «сильный
 * кандидат»): every word of the item's name is in the row (in any form),
 * and every word of the row is in the item's name, brand or category — a
 * row naming a model the item doesn't («… Geely Coolray» for pads of an
 * Atlas) is not sure; the key characteristics — every token with a digit (a
 * size, a volume, a viscosity grade, a code) — are the same on both sides;
 * the item's brand, if it has one, is named by the row; and the name says
 * enough (two terms at least). Anything less goes to AI or to the supplier.
 */
export function isStrongCandidate(row: NameRow, candidate: NameCandidate): boolean {
  // Two articles that differ are two items, however alike their names.
  if (row.articleNorm && candidate.article) {
    if (normalizeArticle(candidate.article) !== row.articleNorm) return false;
  }
  const rowText = `${row.name ?? ""} ${row.brand ?? ""}`;
  const rowReading = readingOf(rowText);
  const rowTokens = nameTokens(rowText);
  const own = readingOf(candidate.name);
  if (own.words.length + own.marks.length < 2) return false;
  const brandWords = new Set(candidate.brandSpellings.flatMap((spelling) => nameTokens(spelling)));
  // The brand is checked on its own: the row may name it in its own cell only.
  const words = own.words.filter((word) => !brandWords.has(word));
  if (!words.every((word) => hasWord(rowReading.words, word))) return false;
  const described = [...own.words, ...brandWords, ...readingOf(candidate.context ?? "").words];
  if (!rowReading.words.every((word) => hasWord(described, word))) return false;
  const articleMarks = candidate.article ? nameTokens(candidate.article) : [];
  if (!own.marks.every((mark) => rowReading.marks.includes(mark))) return false;
  if (!rowReading.marks.every((mark) => own.marks.includes(mark) || articleMarks.includes(mark))) {
    return false;
  }
  return brandFits(row, candidate, rowTokens);
}

/** The one strong candidate of a row; `null` — none, or more than one (then nothing is sure). */
export function strongCandidate<Candidate extends NameCandidate>(
  row: NameRow,
  candidates: readonly Candidate[],
): Candidate | null {
  const strong = candidates.filter((candidate) => isStrongCandidate(row, candidate));
  return strong.length === 1 ? strong[0]! : null;
}

/** The words of a row worth searching the catalog by: the longest first, at most `limit`. */
export function searchWords(row: NameRow, limit: number): string[] {
  const reading = readingOf(`${row.name ?? ""}`);
  const unique = [
    ...new Set([...reading.marks.filter((mark) => mark.length >= 3), ...reading.words]),
  ];
  return unique.sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0)).slice(0, limit);
}

// ------------------------------------------------------------ the price

/**
 * A sharp change of the price (D-039, D-052): the new price differs from the
 * current one of the offer by more than `percent` per cent of it. Such a row
 * is applied only when the supplier confirmed the price.
 */
export function sharpPriceChange(current: number | null, next: number, percent: number): boolean {
  if (current === null || current <= 0) return false;
  return Math.abs(next - current) * 100 > percent * current;
}
