import {
  priceColumnRoles,
  priceDoubtWords,
  priceHeaderSpellings,
  priceTotalWords,
  priceUnitWords,
  type PriceColumnRole,
  type PriceDataRole,
} from "./column-headers";
import { readAvailability, readDecimal, readLeadDays, type PriceCell } from "./price-values";

/**
 * Finding the header of a price list, telling its service rows from the
 * goods and recognising what each column holds (TASK-046 requirements 2–3;
 * ARCHITECTURE 12.1 steps 2–3, 4.66). Deterministic: the same rows give the
 * same answer, and the supplier confirms it on S-PRICE-02.
 */

/** Lower case, «ё» as «е», everything but letters and digits as one space. */
export function normalizeHeader(value: PriceCell): string {
  if (value === null) return "";
  return String(value)
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

interface Spelling {
  role: PriceDataRole;
  words: string[];
  weight: number;
}

const SPELLINGS: readonly Spelling[] = (
  Object.entries(priceHeaderSpellings) as [PriceDataRole, { text: string; weight: number }[]][]
).flatMap(([role, spellings]) =>
  spellings.map((spelling) => ({
    role,
    words: normalizeHeader(spelling.text).split(" "),
    weight: spelling.weight,
  })),
);

const DOUBT_WORDS = new Set(priceDoubtWords.map((word) => normalizeHeader(word)));
const UNIT_WORDS = new Set(priceUnitWords.map((word) => normalizeHeader(word)));

function containsWords(header: readonly string[], words: readonly string[]): boolean {
  for (let start = 0; start + words.length <= header.length; start++) {
    if (words.every((word, at) => header[start + at] === word)) return true;
  }
  return false;
}

export interface HeaderGuess {
  role: PriceDataRole;
  /** 0…1: how sure the header is of it. */
  score: number;
}

/**
 * What a header says about its column. The longest spelling found among
 * its words decides (so «Цена опт» is the doubtful wholesale price rather
 * than «Цена»); a spelling that is the whole header counts in full, one
 * inside a longer header — a little less.
 */
export function guessRoleByHeader(header: PriceCell): HeaderGuess | null {
  const normal = normalizeHeader(header);
  if (normal === "") return null;
  const words = normal.split(" ");
  let best: { spelling: Spelling; exact: boolean } | null = null;
  for (const spelling of SPELLINGS) {
    if (!containsWords(words, spelling.words)) continue;
    const exact = spelling.words.length === words.length;
    if (
      !best ||
      spelling.words.length > best.spelling.words.length ||
      (spelling.words.length === best.spelling.words.length &&
        spelling.weight > best.spelling.weight)
    ) {
      best = { spelling, exact };
    }
  }
  if (!best) return null;
  let score = best.spelling.weight * (best.exact ? 1 : 0.9);
  if (best.spelling.role === "price" && words.some((word) => DOUBT_WORDS.has(word))) {
    score = Math.min(score, 0.5);
  }
  return { role: best.spelling.role, score };
}

function nonEmpty(cells: readonly PriceCell[]): PriceCell[] {
  return cells.filter((cell) => cell !== null && String(cell).trim() !== "");
}

function isNumeric(cell: PriceCell): boolean {
  if (typeof cell === "number") return true;
  if (cell === null) return false;
  const value = cell.replace(/(₸|тенге|тг\.?|kzt)/gi, "").trim();
  return value !== "" && readDecimal(value) !== null;
}

/** How many different roles a row's cells name as headers. */
function headerRoles(cells: readonly PriceCell[]): number {
  const roles = new Set<PriceDataRole>();
  for (const cell of cells) {
    const guess = guessRoleByHeader(cell);
    if (guess && guess.score >= 0.5) roles.add(guess.role);
  }
  return roles.size;
}

/** A row with goods-like cells: two or more filled, at least one a number. */
function looksLikeData(cells: readonly PriceCell[]): boolean {
  const filled = nonEmpty(cells);
  return filled.length >= 2 && filled.some(isNumeric);
}

/** How many rows from the top the header is looked for in. */
export const HEADER_SEARCH_ROWS = 40;

/**
 * The index (in `rows`, the first non-empty rows of the file) of the header:
 * the first row whose cells name two different roles («Артикул»,
 * «Наименование», «Цена»…); failing that, the first row of two or more
 * text cells, none of them numbers, followed within three rows by a row of
 * goods. `null` — the file has no header: its first row is goods already.
 * A shop title, an address, a date in the first rows of a 1C export are
 * passed over by either rule.
 */
export function findPriceHeader(rows: readonly (readonly PriceCell[])[]): number | null {
  const searched = rows.slice(0, HEADER_SEARCH_ROWS);
  const named = searched.findIndex((cells) => headerRoles(cells) >= 2);
  if (named >= 0) return named;
  for (let index = 0; index < searched.length; index++) {
    const filled = nonEmpty(searched[index]!);
    const distinct = new Set(filled.map((cell) => normalizeHeader(cell)));
    if (filled.length < 2 || distinct.size < 2 || filled.some(isNumeric)) continue;
    if (searched.slice(index + 1, index + 4).some(looksLikeData)) return index;
  }
  return null;
}

export type PriceRowKind = "title" | "header" | "repeat_header" | "group" | "total" | "data";

const TOTAL_WORDS = priceTotalWords.map((word) => normalizeHeader(word));

/**
 * What a row below the header is: a row of totals («Итого», «Барлығы»), a
 * group separator (one filled cell — «ТОРМОЗНАЯ СИСТЕМА»), the header
 * repeated (a 1C export repeats it on every printed page) or goods. Rows
 * above the header are `title`; empty rows are never stored.
 */
export function classifyPriceRow(
  cells: readonly PriceCell[],
  headerKey: string | null,
): Exclude<PriceRowKind, "title" | "header"> {
  const filled = nonEmpty(cells);
  const first = normalizeHeader(filled[0] ?? null);
  if (TOTAL_WORDS.some((word) => first === word || first.startsWith(`${word} `))) return "total";
  if (filled.length === 1 && typeof filled[0] === "string") return "group";
  if (headerKey !== null && priceHeaderKey(cells) === headerKey) return "repeat_header";
  return "data";
}

/**
 * The header as the key a remembered format is found by: the normal form of
 * each cell, trailing empty cells dropped. Two files of one supplier with
 * the same columns in the same order have the same key, whatever case or
 * punctuation their headers use.
 */
export function priceHeaderKey(header: readonly PriceCell[]): string {
  const cells = header.map((cell) => normalizeHeader(cell));
  while (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
  return cells.join("\u001f");
}

export type ColumnGuessSource = "header" | "content";

export interface PriceColumnGuess {
  role: PriceColumnRole;
  /** Where the role came from; `null` — nothing pointed at a role («Не использовать»). */
  source: ColumnGuessSource | null;
  /** 0…1. */
  confidence: number;
}

/** The roles a file must have: a price, and an article or a name. */
export function missingPriceRoles(
  roles: readonly PriceColumnRole[],
): ("price" | "article_or_name")[] {
  const missing: ("price" | "article_or_name")[] = [];
  if (!roles.includes("price")) missing.push("price");
  if (!roles.includes("article") && !roles.includes("name")) missing.push("article_or_name");
  return missing;
}

/**
 * Whether a set of roles can be taken: one column per role (except «Не
 * использовать») and the required ones present.
 */
export function priceRolesProblem(
  roles: readonly PriceColumnRole[],
):
  | { kind: "unknown_role" }
  | { kind: "repeated"; role: PriceDataRole }
  | { kind: "missing" }
  | null {
  const seen = new Set<PriceColumnRole>();
  for (const role of roles) {
    if (!(priceColumnRoles as readonly string[]).includes(role)) return { kind: "unknown_role" };
    if (role !== "ignore" && seen.has(role)) return { kind: "repeated", role };
    seen.add(role);
  }
  return missingPriceRoles(roles).length > 0 ? { kind: "missing" } : null;
}

interface ColumnFacts {
  filled: number;
  numeric: number;
  /** Median of the numbers of the column. */
  median: number;
  integers: number;
  availabilityWords: number;
  leadWords: number;
  /** Cells with a digit and no space, short — article-like. */
  codeLike: number;
  /** Average length of the text cells. */
  textLength: number;
  textWithSpaces: number;
  distinct: number;
  letters: number;
  units: number;
}

function factsOf(values: readonly PriceCell[]): ColumnFacts {
  const filled = nonEmpty(values);
  const numbers = filled.filter(isNumeric).map((cell) =>
    typeof cell === "number"
      ? cell
      : (readDecimal(
          String(cell)
            .replace(/(₸|тенге|тг\.?|kzt)/gi, "")
            .trim(),
        ) ?? 0),
  );
  const sorted = [...numbers].sort((a, b) => a - b);
  const texts = filled.filter((cell) => !isNumeric(cell)).map((cell) => String(cell).trim());
  return {
    filled: filled.length,
    numeric: numbers.length,
    median: sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)]! : 0,
    integers: numbers.filter((number) => Number.isInteger(number)).length,
    availabilityWords: texts.filter(
      (cell) => readAvailability(cell).availability !== null && !/\d/.test(cell),
    ).length,
    leadWords: texts.filter(
      (cell) => readLeadDays(cell) !== null && /(дн|день|дня|дней|days?|күн|нед|week)/i.test(cell),
    ).length,
    codeLike: filled.filter((cell) => {
      const value = String(cell).trim();
      return /\d/.test(value) && !/\s/.test(value) && value.length >= 3 && value.length <= 30;
    }).length,
    textLength:
      texts.length > 0 ? texts.reduce((sum, cell) => sum + cell.length, 0) / texts.length : 0,
    textWithSpaces: texts.filter((cell) => /\s/.test(cell)).length,
    distinct: new Set(filled.map((cell) => normalizeHeader(cell))).size,
    letters: texts.filter((cell) => /\p{L}/u.test(cell)).length,
    units: texts.filter((cell) => UNIT_WORDS.has(normalizeHeader(cell))).length,
  };
}

/** How much of the filled cells — at least this — makes a pattern of the column. */
const MOSTLY = 0.7;

/** What the cells of a column say it is, best first, with a confidence. */
function guessesByContent(facts: ColumnFacts): { role: PriceDataRole; score: number }[] {
  // A column of units of measure is no role at all.
  if (facts.filled === 0 || facts.units / facts.filled >= MOSTLY) return [];
  const share = (count: number) => count / facts.filled;
  const guesses: { role: PriceDataRole; score: number }[] = [];
  if (share(facts.availabilityWords) >= MOSTLY) guesses.push({ role: "availability", score: 0.7 });
  if (share(facts.leadWords) >= MOSTLY) guesses.push({ role: "lead_days", score: 0.7 });
  if (share(facts.numeric) >= MOSTLY) {
    if (facts.median >= 100) guesses.push({ role: "price", score: 0.6 });
    else if (share(facts.integers) >= MOSTLY) guesses.push({ role: "availability", score: 0.4 });
  }
  if (share(facts.codeLike) >= MOSTLY && share(facts.numeric) < 1) {
    guesses.push({ role: "article", score: 0.6 });
  }
  if (
    share(facts.letters) >= MOSTLY &&
    share(facts.textWithSpaces) >= 0.5 &&
    facts.textLength >= 12
  ) {
    guesses.push({ role: "name", score: 0.6 });
  }
  if (
    share(facts.letters) >= MOSTLY &&
    facts.textLength < 20 &&
    share(facts.textWithSpaces) < 0.5 &&
    facts.distinct <= Math.max(2, facts.filled * 0.6)
  ) {
    guesses.push({ role: "brand", score: 0.4 });
  }
  return guesses;
}

/** A header must be at least this sure to give its column a role. */
const HEADER_THRESHOLD = 0.5;

/**
 * The roles of the columns of a price list: first by the headers (each role
 * to the column whose header names it most surely — so of «Опт» and
 * «Розница» the price is «Розница», and «Опт» stays «Не использовать» for
 * the supplier to choose), then, for the roles still free, by what the
 * cells of the columns without a role look like (numbers in hundreds and
 * thousands — a price; codes of digits and letters without spaces — an
 * article; long text — a name; «есть / нет / под заказ» — availability).
 * `header` — the header row (`null` — the file has none); `samples` — the
 * first rows of goods; `width` — how many columns there are.
 */
export function recognizePriceColumns(
  header: readonly PriceCell[] | null,
  samples: readonly (readonly PriceCell[])[],
  width: number,
): PriceColumnGuess[] {
  const guesses: PriceColumnGuess[] = Array.from({ length: width }, () => ({
    role: "ignore",
    source: null,
    confidence: 0,
  }));
  const taken = new Set<PriceDataRole>();

  const byHeader = Array.from({ length: width }, (_, index) =>
    header ? guessRoleByHeader(header[index] ?? null) : null,
  )
    .map((guess, index) => ({ guess, index }))
    .filter(
      (entry): entry is { guess: HeaderGuess; index: number } =>
        entry.guess !== null && entry.guess.score >= HEADER_THRESHOLD,
    )
    // The surest first; of equals, the leftmost.
    .sort((a, b) => b.guess.score - a.guess.score || a.index - b.index);
  for (const { guess, index } of byHeader) {
    if (taken.has(guess.role)) continue;
    taken.add(guess.role);
    guesses[index] = { role: guess.role, source: "header", confidence: guess.score };
  }

  const byContent = guesses
    .map((guess, index) => ({ guess, index }))
    .filter(({ guess, index }) => guess.source === null && !hasHeaderRole(header, index))
    .flatMap(({ index }) =>
      guessesByContent(factsOf(samples.map((row) => row[index] ?? null))).map((guess) => ({
        ...guess,
        index,
        median: factsOf(samples.map((row) => row[index] ?? null)).median,
      })),
    )
    // The surest first; of two price-like columns, the dearer (retail over wholesale).
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.role === "price" && b.role === "price" ? b.median - a.median : 0) ||
        a.index - b.index,
    );
  for (const { role, score, index } of byContent) {
    if (taken.has(role) || guesses[index]!.source !== null) continue;
    taken.add(role);
    guesses[index] = { role, source: "content", confidence: score };
  }
  return guesses;
}

/** A column whose header names a role that was taken by another one: content doesn't override it. */
function hasHeaderRole(header: readonly PriceCell[] | null, index: number): boolean {
  if (!header) return false;
  const guess = guessRoleByHeader(header[index] ?? null);
  return guess !== null && guess.score >= HEADER_THRESHOLD;
}
