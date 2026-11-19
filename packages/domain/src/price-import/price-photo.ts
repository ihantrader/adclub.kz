import { normalizeArticle } from "../article/normalize-article";
import type { PriceColumnRole } from "./column-headers";
import { priceNameKey, priceRowKey, type PriceRowKey } from "./price-match";
import { readArticle, readAvailability, readName, type PriceCell } from "./price-values";

/**
 * A price list photographed (TASK-064; ARCHITECTURE 12.1 step 2, 4.93): a
 * model reads every page into rows of the roles of TASK-046, and these pure
 * functions turn what it answered into rows the import stores — the cells
 * by `PRICE_PHOTO_ROLES`, so the values are read by `readPriceRow` exactly
 * as a file's, and what the model was not sure of. The model's answer is
 * never trusted as it is: texts are cut and cleaned, a price that is no
 * number goes, a row without an article, a name and a price is dropped.
 */

/** The fields of a row the model reads, in the order of the stored cells. */
export const PRICE_PHOTO_FIELDS = [
  "article",
  "brand",
  "name",
  "price",
  "availability",
  "lead_days",
] as const;

export type PricePhotoField = (typeof PRICE_PHOTO_FIELDS)[number];

/** The roles of the columns of a photographed price: known, so S-PRICE-02 isn't shown. */
export const PRICE_PHOTO_ROLES: readonly PriceColumnRole[] = PRICE_PHOTO_FIELDS;

/** A cell the model was unsure of, or `row` — the whole row (a crease, a blur, a hand). */
export type PricePhotoUncertainty = PricePhotoField | "row";

/** A row as the model answers it (before any check). */
export interface PricePhotoModelRow {
  /** The row as the model read it, word for word. */
  text: string | null;
  article: string | null;
  brand: string | null;
  name: string | null;
  /** In tenge; `null` — no price in the row or not a number («по запросу»). */
  price: number | null;
  availability: string | null;
  leadTime: string | null;
  uncertain: readonly string[];
}

export interface PricePhotoModelAnswer {
  kind: "price_list" | "not_a_table" | "unreadable";
  rows: readonly PricePhotoModelRow[];
}

/** A row of a photographed page as the import keeps it. */
export interface PricePhotoRow {
  /** `PRICE_PHOTO_ROLES` order. */
  cells: PriceCell[];
  /** The source text: what the model read, shown next to the row in the review. */
  text: string;
  uncertain: PricePhotoUncertainty[];
}

/**
 * What a page gave: rows; no table on it (a page of text, a photo of a
 * car, an answer without a single row); or nothing could be read.
 */
export type PricePhotoPage =
  | { kind: "rows"; rows: PricePhotoRow[]; dropped: number }
  | { kind: "no_table" }
  | { kind: "unreadable" };

/** The longest cell kept (a cell of a file is cut at 1000, a photo's is a line of print). */
export const PRICE_PHOTO_CELL_MAX = 300;
/** The longest source text kept. */
export const PRICE_PHOTO_TEXT_MAX = 500;
/** The most rows one page may give; more is no price list but a model gone astray. */
export const PRICE_PHOTO_PAGE_ROWS_MAX = 1000;

const UNCERTAINTIES: ReadonlySet<string> = new Set([...PRICE_PHOTO_FIELDS, "row"]);

// Control characters a model may copy off a garbled photo; never kept.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u2029\ufeff]/g;

/** A text cell: one line, trimmed, cut; empty — `null`. */
export function photoText(value: unknown, max = PRICE_PHOTO_CELL_MAX): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  // «—», «-», «…» in a cell say there is nothing there.
  if (text === "" || /^[\p{P}\p{S}\s]+$/u.test(text)) return null;
  return text.slice(0, max).trim();
}

/** A price the model gives: a finite number not below zero; anything else — `null`. */
export function photoPrice(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

/**
 * One row of the model checked: its cells, its source text and what was
 * uncertain; `null` — nothing to import (no article, no name, no price).
 */
export function pricePhotoRow(row: PricePhotoModelRow): PricePhotoRow | null {
  const article = photoText(row.article);
  const brand = photoText(row.brand);
  const name = photoText(row.name);
  const price = photoPrice(row.price);
  const availability = photoText(row.availability);
  const leadTime = photoText(row.leadTime);
  if (article === null && name === null && price === null) return null;
  const uncertain = new Set<PricePhotoUncertainty>();
  for (const field of Array.isArray(row.uncertain) ? row.uncertain : []) {
    if (typeof field === "string" && UNCERTAINTIES.has(field)) {
      uncertain.add(field as PricePhotoUncertainty);
    }
  }
  // A price the model gave that is no price: the row is not read for sure.
  if (row.price !== null && price === null) uncertain.add("price");
  const cells: PriceCell[] = [article, brand, name, price, availability, leadTime];
  const text =
    photoText(row.text, PRICE_PHOTO_TEXT_MAX) ??
    cells
      .filter((cell): cell is string | number => cell !== null)
      .map(String)
      .join(" · ")
      .slice(0, PRICE_PHOTO_TEXT_MAX);
  return {
    cells,
    text,
    uncertain: [...uncertain].sort((a, b) => uncertaintyOrder(a) - uncertaintyOrder(b)),
  };
}

function uncertaintyOrder(field: PricePhotoUncertainty): number {
  return field === "row" ? -1 : PRICE_PHOTO_FIELDS.indexOf(field);
}

/**
 * The page by the model's answer. A list that gave no row (or only rows
 * with nothing to import) is «на фото нет таблицы»: nothing of it is
 * applied, the supplier retakes it. Rows past `PRICE_PHOTO_PAGE_ROWS_MAX`
 * are dropped and counted.
 */
export function pricePhotoPage(answer: PricePhotoModelAnswer): PricePhotoPage {
  if (answer.kind === "unreadable") return { kind: "unreadable" };
  if (answer.kind === "not_a_table") return { kind: "no_table" };
  const rows: PricePhotoRow[] = [];
  let dropped = 0;
  for (const raw of answer.rows) {
    const row = pricePhotoRow(raw);
    if (row === null) continue;
    if (rows.length >= PRICE_PHOTO_PAGE_ROWS_MAX) {
      dropped++;
      continue;
    }
    rows.push(row);
  }
  return rows.length === 0 ? { kind: "no_table" } : { kind: "rows", rows, dropped };
}

/**
 * The share of rows two readings must agree on for the page to be read at
 * all (TASK-064, ARCHITECTURE 4.93): measured, a model asked about a page it
 * can't read (out of focus) invents a table — and another one the next time;
 * a page it reads gives the same rows twice.
 */
export const PRICE_PHOTO_AGREEMENT_MIN = 0.5;

/** A row by what it is: the article (normal form), without one — the name. */
function photoRowKey(row: PricePhotoRow): string | null {
  const article = row.cells[0];
  if (typeof article === "string") {
    const norm = normalizeArticle(article);
    if (norm) return `a:${norm}`;
  }
  const name = row.cells[2];
  return typeof name === "string" ? `n:${priceNameKey(name)}` : null;
}

/**
 * Two readings of one page made one (TASK-064): the rows of the first
 * reading that the second one also gives — the same article (or name) and
 * the same price and stock — keep what the model doubted in either (each
 * row of the second reading confirms one row only); a row the second
 * reading doesn't confirm is doubtful as a whole (`row`). When fewer than
 * `PRICE_PHOTO_AGREEMENT_MIN` of the rows agree, or the second reading sees
 * no table at all, the page is «не читается»: its rows were made up.
 */
export function agreePricePhotoPages(
  first: PricePhotoPage,
  second: PricePhotoPage,
): PricePhotoPage {
  if (first.kind !== "rows") return first;
  if (second.kind !== "rows") return { kind: "unreadable" };
  const others = new Map<string, PricePhotoRow>();
  for (const row of second.rows) {
    const key = photoRowKey(row);
    if (key !== null && !others.has(key)) others.set(key, row);
  }
  let agreed = 0;
  const rows = first.rows.map((row) => {
    const key = photoRowKey(row);
    const other = key === null ? undefined : others.get(key);
    if (
      other &&
      other.cells[3] === row.cells[3] &&
      readAvailability(other.cells[4] ?? null).availability ===
        readAvailability(row.cells[4] ?? null).availability
    ) {
      // One row of the second reading confirms one row of the first.
      others.delete(key!);
      agreed++;
      const uncertain = new Set([...row.uncertain, ...other.uncertain]);
      return {
        ...row,
        uncertain: [...uncertain].sort((a, b) => uncertaintyOrder(a) - uncertaintyOrder(b)),
      };
    }
    return {
      ...row,
      uncertain: ["row" as const, ...row.uncertain.filter((field) => field !== "row")],
    };
  });
  if (agreed / first.rows.length < PRICE_PHOTO_AGREEMENT_MIN) return { kind: "unreadable" };
  return { kind: "rows", rows, dropped: first.dropped };
}

/**
 * The keys of the rows a reading of a page gave (TASK-064.A): by their
 * article, without one — their name, exactly as `priceRowKey` knows the row
 * once it is read (`readPriceRow`). Taken from every reading, the agreed
 * rows and the ones only one reading saw: an item printed on the photo is
 * not «missing» from it because a reading left its row out — though such a
 * row never becomes a row of the review.
 */
export function pricePhotoRowKeys(...pages: readonly PricePhotoPage[]): PriceRowKey[] {
  const keys = new Map<string, PriceRowKey>();
  for (const page of pages) {
    if (page.kind !== "rows") continue;
    for (const row of page.rows) {
      const key = priceRowKey({
        articleNorm: readArticle(row.cells[0] ?? null)?.articleNorm ?? null,
        name: readName(row.cells[2] ?? null),
      });
      if (key) keys.set(`${key.kind}:${key.key}`, key);
    }
  }
  return [...keys.values()];
}

/** A row read with doubt: never applied without the supplier's «Прочитано верно». */
export function pricePhotoRowUncertain(row: Pick<PricePhotoRow, "uncertain">): boolean {
  return row.uncertain.length > 0;
}
