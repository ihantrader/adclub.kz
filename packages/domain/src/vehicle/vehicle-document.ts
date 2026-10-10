/**
 * VIN and the Kazakhstan registration plate (D-064, TASK-057; SCREENS
 * T-GAR-07): one set of rules for what the server stores and checks, what
 * the app checks before sending, and how a recognised document is read.
 *
 * - A VIN is 17 characters of `A–Z` and `0–9` without `I`, `O` and `Q`,
 *   upper case. The check digit (9th character) is **not** required: many
 *   Chinese makes sold in Kazakhstan don't follow it.
 * - A plate is written as on the plate itself: `123 ABC 02` (since 2012:
 *   three digits, two or three Latin letters, the region 01–20) or the
 *   older `A 123 BCD` (the region letter first). It is kept compact
 *   (`123ABC02`) and shown with spaces.
 * - Cyrillic letters that look like Latin ones (a document or a keyboard
 *   in Russian layout) are read as the Latin letter: that is not a guess,
 *   the plate and the VIN have no Cyrillic letters at all. A `0` is never
 *   read as `O` or the other way round — anything that does not fit is
 *   refused, not corrected (an unreadable VIN is empty, not a guess).
 */

/** Cyrillic letters that look exactly like a Latin capital, and that Latin capital. */
const LOOK_ALIKE: Readonly<Record<string, string>> = {
  А: "A",
  В: "B",
  Е: "E",
  К: "K",
  М: "M",
  Н: "H",
  О: "O",
  Р: "P",
  С: "C",
  Т: "T",
  Х: "X",
  У: "Y",
};

/** Separators people type or a model writes inside a VIN or a plate. */
const SEPARATORS = /[\s\-–—.·_/]/gu;

function compact(input: string): string {
  let result = "";
  for (const char of input.replace(SEPARATORS, "").toUpperCase()) {
    result += LOOK_ALIKE[char] ?? char;
  }
  return result;
}

const VIN = /^[A-HJ-NPR-Z0-9]{17}$/;

export type VinCheck =
  | { ok: true; vin: string }
  | {
      ok: false;
      /** `length` — not 17 characters; `characters` — a letter I, O, Q or a sign that is not a letter or a digit. */
      reason: "length" | "characters";
    };

/** A VIN as typed or read, checked: upper case, without spaces; or why it is not one. */
export function checkVin(input: string): VinCheck {
  const value = compact(input);
  if (value.length !== 17) {
    return { ok: false, reason: "length" };
  }
  return VIN.test(value) ? { ok: true, vin: value } : { ok: false, reason: "characters" };
}

/** The VIN in its stored form, or `null` when the text is not a VIN. */
export function normalizeVin(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  const checked = checkVin(input);
  return checked.ok ? checked.vin : null;
}

/** Since 2012: `123ABC02` / `123AB02` (a company), the region last. */
const PLATE_CURRENT = /^(\d{3})([A-Z]{2,3})(0[1-9]|1\d|20)$/;
/** 1993–2012: `A123BCD`, the region letter first. */
const PLATE_OLD = /^([A-Z])(\d{3})([A-Z]{2,3})$/;

/** The plate in its stored form (`123ABC02`), or `null` when the text is not a Kazakhstan plate. */
export function normalizeKzPlate(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  const value = compact(input);
  return PLATE_CURRENT.test(value) || PLATE_OLD.test(value) ? value : null;
}

/** A stored plate as it is written on the plate: `123 ABC 02`, `A 123 BCD`. */
export function formatKzPlate(plate: string): string {
  const current = PLATE_CURRENT.exec(plate);
  if (current) return `${current[1]} ${current[2]} ${current[3]}`;
  const old = PLATE_OLD.exec(plate);
  if (old) return `${old[1]} ${old[2]} ${old[3]}`;
  return plate;
}

/**
 * A VIN as a log line, the action journal or monitoring may carry it
 * (D-064, as a phone number — ARCHITECTURE 15.3): the maker's code and the
 * last four characters, `LB3**********4567`. Not enough to find the car.
 */
export function maskVin(vin: string): string {
  const value = compact(vin);
  if (value.length < 8) return "***";
  return `${value.slice(0, 3)}${"*".repeat(value.length - 7)}${value.slice(-4)}`;
}

/** A plate the same way: only the region stays, `*** *** 02` / `A *** ***`. */
export function maskKzPlate(plate: string): string {
  const value = compact(plate);
  const current = PLATE_CURRENT.exec(value);
  if (current) return `*** *** ${current[3]}`;
  const old = PLATE_OLD.exec(value);
  if (old) return `${old[1]} *** ***`;
  return "***";
}

/**
 * The engine size a registration certificate states, in cm³ («1477»,
 * «1 477 см³», «1.5»), as whole cubic centimetres; `null` when it is not a
 * plausible engine size of a passenger car or a light truck.
 */
export function engineVolumeCc(input: number | string | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  let value: number;
  if (typeof input === "number") {
    value = input;
  } else {
    const text = input.replace(/\s/gu, "").replace(",", ".");
    const number = /^\d+(?:\.\d+)?/u.exec(text);
    if (!number) return null;
    value = Number(number[0]);
  }
  if (!Number.isFinite(value) || value <= 0) return null;
  // A size in litres (1.5) rather than cm³.
  const cc = value < 10 ? Math.round(value * 1000) : Math.round(value);
  return cc >= 500 && cc <= 9000 ? cc : null;
}

/**
 * Whether an engine of the catalog (litres, as the catalog keeps it) is the
 * size a certificate states: the catalog rounds to a tenth of a litre
 * (1477 cm³ is «1.5»), so anything within 60 cm³ of it is.
 */
export function engineMatchesVolume(displacementL: number, cc: number): boolean {
  return Math.abs(displacementL * 1000 - cc) <= 60;
}
