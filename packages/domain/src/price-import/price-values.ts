import { normalizeArticle } from "../article/normalize-article";
import type { PriceColumnRole } from "./column-headers";

/**
 * Reading the values of one row of a price list by the roles of its columns
 * (TASK-046 requirement 3; ARCHITECTURE 12.1 step 3, 4.66). One function per
 * role and one for the row; the worker and the tests call exactly these.
 *
 * A cell is what the file held: a string of a CSV or of a text cell of
 * Excel, a number of a numeric cell (a date is already an ISO string), or
 * nothing.
 */

export type PriceCell = string | number | null;

export type PriceAvailability = "in_stock" | "out_of_stock" | "on_order";

/** Spaces of every kind a spreadsheet or 1C puts between thousands. */
const SPACES = /[\s\u00a0\u2007\u202f\u2009']+/g;

function text(cell: PriceCell): string {
  if (cell === null) return "";
  return typeof cell === "number" ? numberText(cell) : cell.trim();
}

/** A number as a person would write it: no exponent, no float dust. */
export function numberText(value: number): string {
  if (Number.isInteger(value)) return value.toFixed(0);
  return String(Number.parseFloat(value.toPrecision(15)));
}

/** Lower case, «ё» as «е», runs of spaces as one. */
function plain(value: string): string {
  return value.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}

/**
 * A decimal written with any of the separators people use: «12 500»,
 * «12 500,00», «12500.5», «12,500.00», «1.234.567». Of «.» and «,» the last
 * one present is the decimal point when both are; a single separator
 * followed by exactly three digits separates thousands (a price has no
 * thousandths), otherwise it is the decimal point. `null` — not a number.
 */
export function readDecimal(value: string): number | null {
  const compact = value.replace(SPACES, "");
  if (!/^[+-]?[\d.,]*\d[\d.,]*$/.test(compact)) return null;
  const sign = compact.startsWith("-") ? -1 : 1;
  let digits = compact.replace(/^[+-]/, "");
  const lastDot = digits.lastIndexOf(".");
  const lastComma = digits.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    const decimal = lastDot > lastComma ? "." : ",";
    const thousands = decimal === "." ? "," : ".";
    digits = digits.split(thousands).join("").replace(decimal, ".");
  } else if (lastDot >= 0 || lastComma >= 0) {
    const separator = lastDot >= 0 ? "." : ",";
    const parts = digits.split(separator);
    const thousands =
      parts.length > 2 ||
      (parts[1]!.length === 3 && parts[0]!.length > 0 && !/^0+$/.test(parts[0]!));
    digits = thousands ? parts.join("") : parts.join(".");
  }
  if (!/^\d*\.?\d+$|^\d+\.$/.test(digits)) return null;
  const number = Number.parseFloat(digits);
  return Number.isFinite(number) ? sign * number : null;
}

/** Words of a currency after (or before) a price; dropped before reading it. */
const CURRENCY = /(₸|тенге|теңге|тнг|тг\.?|kzt|tg\b|т\.(?=\s*$)|т(?=\s*$))/gi;

export type PriceReading =
  { kind: "price"; value: number } | { kind: "missing" } | { kind: "not_number"; text: string };

/**
 * The price of a cell in whole tenge. A fraction is rounded to the nearest
 * tenge, half up: 12 500,50 ₸ → 12 501 (a price list in tiyn is not a thing;
 * a calculated retail price with a fraction is). «по запросу», «договорная»
 * — not a number.
 */
export function readPrice(cell: PriceCell): PriceReading {
  if (cell === null) return { kind: "missing" };
  if (typeof cell === "number") {
    return Number.isFinite(cell) ? { kind: "price", value: roundTenge(cell) } : { kind: "missing" };
  }
  const raw = cell.trim();
  if (raw === "" || /^[-–—]+$/.test(raw)) return { kind: "missing" };
  const withoutCurrency = raw.replace(CURRENCY, " ").trim();
  const value = readDecimal(withoutCurrency);
  if (value === null) return { kind: "not_number", text: raw };
  return { kind: "price", value: roundTenge(value) };
}

function roundTenge(value: number): number {
  // Half up for positive prices; float dust (12500.4999999) is settled first.
  return Math.round(Number.parseFloat(value.toFixed(6)));
}

export interface AvailabilityReading {
  availability: PriceAvailability | null;
  /** How many there are, when the cell says it. */
  quantity: number | null;
}

const IN_STOCK = new Set([
  "есть",
  "есть в наличии",
  "в наличии",
  "наличие",
  "имеется",
  "да",
  "+",
  "++",
  "+++",
  "много",
  "достаточно",
  "в наличии на складе",
  "на складе",
  "yes",
  "y",
  "true",
  "in stock",
  "available",
  "бар",
  "қоймада бар",
  "қоймада",
  "иә",
]);

const OUT_OF_STOCK = new Set([
  "нет",
  "нет в наличии",
  "отсутствует",
  "нет на складе",
  "-",
  "—",
  "–",
  "no",
  "n",
  "false",
  "out of stock",
  "not available",
  "жоқ",
  "қоймада жоқ",
]);

const ON_ORDER = new Set([
  "под заказ",
  "заказ",
  "на заказ",
  "по заказу",
  "под заказ из китая",
  "ожидается",
  "в пути",
  "on order",
  "to order",
  "order",
  "backorder",
  "тапсырыспен",
  "тапсырыс бойынша",
  "тапсырыс",
]);

/** «5», «5 шт», «>10», «10+», «более 10», «~20». */
const QUANTITY =
  /^(?:[<>≥≤~≈]=?\s*|более\s+|больше\s+|свыше\s+|от\s+|до\s+|over\s+)?(\d+(?:[.,]\d+)?)\s*(?:шт|штук|pcs|pc|ед|дана|units?)?\.?\s*\+?$/;

/**
 * Whether the goods are there: «есть», «в наличии», «да», a number above 0
 * — in stock; «нет», «0» — not; «под заказ» — on order. A cell that says
 * none of it is unknown (`null`), and so is an empty one: what that means
 * is up to the application of the import (TASK-047), not a row error.
 */
export function readAvailability(cell: PriceCell): AvailabilityReading {
  if (cell === null) return { availability: null, quantity: null };
  if (typeof cell === "number") return quantityReading(cell);
  const value = plain(cell);
  if (value === "") return { availability: null, quantity: null };
  if (OUT_OF_STOCK.has(value)) return { availability: "out_of_stock", quantity: null };
  if (ON_ORDER.has(value)) return { availability: "on_order", quantity: null };
  if (IN_STOCK.has(value)) return { availability: "in_stock", quantity: null };
  const quantity = QUANTITY.exec(value);
  if (quantity) {
    const number = readDecimal(quantity[1]!);
    if (number !== null) {
      const reading = quantityReading(number);
      // «>0», «от 0» still means «some».
      return /^[>≥]|^более|^больше|^свыше|^over|\+$/.test(value) && number === 0
        ? { availability: "in_stock", quantity: null }
        : reading;
    }
  }
  if (/(^|\s)(нет|жоқ)(\s|$)|отсутств|out of stock/.test(value)) {
    return { availability: "out_of_stock", quantity: null };
  }
  if (/заказ|тапсырыс|on order|to order/.test(value)) {
    return { availability: "on_order", quantity: null };
  }
  if (/(^|\s)(есть|бар)(\s|$)|налич|in stock/.test(value)) {
    return { availability: "in_stock", quantity: null };
  }
  return { availability: null, quantity: null };
}

function quantityReading(value: number): AvailabilityReading {
  if (!Number.isFinite(value) || value < 0) return { availability: null, quantity: null };
  if (value === 0) return { availability: "out_of_stock", quantity: 0 };
  return { availability: "in_stock", quantity: Math.floor(value) || null };
}

/** Working days in a week, for «1 неделя». */
const WEEK_DAYS = 5;

/**
 * The lead time in working days: «3», «3 дня», «3 р.д.», «2-3 дня» (the
 * upper bound — the supplier promises at most that), «до 5 дней», «1 нед»
 * (five working days), «сегодня» (0), «завтра» (1). `null` — the cell says
 * no number of days.
 */
export function readLeadDays(cell: PriceCell): number | null {
  if (cell === null) return null;
  if (typeof cell === "number") {
    return Number.isFinite(cell) && cell >= 0 ? Math.max(0, Math.ceil(cell - 1e-9)) : null;
  }
  const value = plain(cell);
  if (value === "") return null;
  if (/^(сегодня|today|бүгін)/.test(value)) return 0;
  if (/^(завтра|tomorrow|ертең)/.test(value)) return 1;
  const numbers = [...value.matchAll(/\d+(?:[.,]\d+)?/g)].map((match) =>
    Number.parseFloat(match[0].replace(",", ".")),
  );
  if (numbers.length === 0) return null;
  // A range «2-3», «2 – 3», «от 2 до 3»: the upper bound.
  const days = Math.max(...numbers.slice(0, 2));
  const weeks = /нед|week|апта/.test(value);
  const months = /мес|month|ай(\s|$)/.test(value);
  const total = weeks ? days * WEEK_DAYS : months ? days * 22 : days;
  return Math.max(0, Math.ceil(total - 1e-9));
}

/** The longest article, brand and name kept (a cell can be anything). */
const ARTICLE_MAX = 100;
const BRAND_MAX = 100;
const NAME_MAX = 500;

export interface ArticleReading {
  /** As the file wrote it. */
  article: string;
  /** `normalizeArticle` of it: what an article is compared by. */
  articleNorm: string;
}

/** The article as written and its normal form; `null` — nothing an article is made of. */
export function readArticle(cell: PriceCell): ArticleReading | null {
  const value = text(cell).replace(/\s+/g, " ").slice(0, ARTICLE_MAX);
  const articleNorm = normalizeArticle(value);
  return articleNorm === "" ? null : { article: value, articleNorm };
}

export function readBrand(cell: PriceCell): string | null {
  const value = text(cell).replace(/\s+/g, " ").slice(0, BRAND_MAX);
  return value === "" ? null : value;
}

export function readName(cell: PriceCell): string | null {
  const value = text(cell).replace(/\s+/g, " ").slice(0, NAME_MAX);
  return value === "" ? null : value;
}

/** The longest text of the item column kept: a wrong value is shown, not stored whole. */
const ITEM_ID_MAX = 64;

/**
 * The cell of the hidden `item_id` column of the cabinet's export (TASK-048):
 * the text as it stands, lower case — whether it is an item of the company
 * is the server's to decide; `null` — an empty cell (a row the supplier
 * added himself goes the usual way).
 */
export function readItemId(cell: PriceCell): string | null {
  const value = text(cell).slice(0, ITEM_ID_MAX).toLowerCase();
  return value === "" ? null : value;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Whether the text of an `item_id` cell is an id at all (anything else is an error of the row). */
export function isItemIdText(value: string): boolean {
  return UUID.test(value);
}

/** What one row of a price list says, by the roles of its columns. */
export interface ParsedPriceRow {
  article: string | null;
  articleNorm: string | null;
  brand: string | null;
  name: string | null;
  price: number | null;
  availability: PriceAvailability | null;
  quantity: number | null;
  leadDays: number | null;
  /**
   * The `item_id` cell of the cabinet's export (TASK-048); absent — the file
   * has no such column.
   */
  itemId?: string | null;
}

export type PriceRowError =
  | { code: "price_missing" }
  | { code: "price_not_number"; text: string }
  | { code: "price_out_of_range"; value: number; min: number; max: number }
  | { code: "no_article_or_name" }
  | { code: "lead_days_out_of_range"; value: number; max: number };

/** The limits of an offer a row must fit (settings `offer_price_*`, `offer_lead_days_max`). */
export interface PriceRowLimits {
  priceMin: number;
  priceMax: number;
  leadDaysMax: number;
}

export interface PriceRowReading {
  parsed: ParsedPriceRow;
  /** Empty — the row can be matched with the catalog (TASK-047). */
  errors: PriceRowError[];
}

/**
 * Reads a row by the roles of its columns (`roles[i]` — the role of column
 * `i`; at most one column per role). A row errs when it has no price, a
 * price that is not a number or out of the limits, neither an article nor
 * a name, or a lead time beyond the limit; a row with an error is still
 * read as far as it goes, so the screen shows what was there.
 */
export function readPriceRow(
  cells: readonly PriceCell[],
  roles: readonly PriceColumnRole[],
  limits: PriceRowLimits,
): PriceRowReading {
  const cellOf = (role: PriceColumnRole): PriceCell => {
    const index = roles.indexOf(role);
    return index >= 0 ? (cells[index] ?? null) : null;
  };
  const article = readArticle(cellOf("article"));
  const name = readName(cellOf("name"));
  const priceReading = readPrice(cellOf("price"));
  const availability = readAvailability(cellOf("availability"));
  const leadDays = readLeadDays(cellOf("lead_days"));
  const errors: PriceRowError[] = [];
  let price: number | null = null;
  if (priceReading.kind === "missing") {
    errors.push({ code: "price_missing" });
  } else if (priceReading.kind === "not_number") {
    errors.push({ code: "price_not_number", text: priceReading.text.slice(0, 100) });
  } else {
    price = priceReading.value;
    if (price < limits.priceMin || price > limits.priceMax) {
      errors.push({
        code: "price_out_of_range",
        value: price,
        min: limits.priceMin,
        max: limits.priceMax,
      });
    }
  }
  if (!article && !name) errors.push({ code: "no_article_or_name" });
  if (leadDays !== null && leadDays > limits.leadDaysMax) {
    errors.push({ code: "lead_days_out_of_range", value: leadDays, max: limits.leadDaysMax });
  }
  return {
    parsed: {
      article: article?.article ?? null,
      articleNorm: article?.articleNorm ?? null,
      brand: readBrand(cellOf("brand")),
      name,
      price,
      availability: availability.availability,
      quantity: availability.quantity,
      leadDays,
      ...(roles.includes("item_id") && { itemId: readItemId(cellOf("item_id")) }),
    },
    errors,
  };
}
