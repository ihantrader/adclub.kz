/**
 * Kazakhstan business identification numbers (БИН) — and individual
 * identification numbers (ИИН), which a sole proprietor uses in its place:
 * both are 12 digits whose last digit is a check digit computed the same
 * way (ARCHITECTURE 4.26).
 *
 * The check digit: the first 11 digits weighted 1, 2, … 11, summed, modulo
 * 11. A remainder of 10 means a second pass with the weights 3, 4, … 11,
 * 1, 2; a remainder of 10 again means no valid number carries these 11
 * digits (such numbers are never issued).
 */

const FIRST_WEIGHTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const SECOND_WEIGHTS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 1, 2];

/** Spaces and dashes people type or paste inside the number. */
const SEPARATORS = /[\s-]/g;

function weightedRemainder(digits: readonly number[], weights: readonly number[]): number {
  return digits.reduce((sum, digit, index) => sum + digit * weights[index]!, 0) % 11;
}

/** The check digit for the first 11 digits, or `null` when none exists. */
export function kzBinCheckDigit(first11: string): number | null {
  if (!/^\d{11}$/.test(first11)) {
    return null;
  }
  const digits = [...first11].map(Number);
  const first = weightedRemainder(digits, FIRST_WEIGHTS);
  if (first !== 10) {
    return first;
  }
  const second = weightedRemainder(digits, SECOND_WEIGHTS);
  return second === 10 ? null : second;
}

export type KzBinCheck =
  | { ok: true; bin: string }
  /** `format` — not 12 digits; `checksum` — 12 digits whose check digit is wrong. */
  | { ok: false; reason: "format" | "checksum" };

/** Normalizes (spaces and dashes dropped) and checks a БИН or ИИН. */
export function checkKzBin(input: string): KzBinCheck {
  const bin = input.replace(SEPARATORS, "");
  if (!/^\d{12}$/.test(bin)) {
    return { ok: false, reason: "format" };
  }
  const expected = kzBinCheckDigit(bin.slice(0, 11));
  if (expected === null || expected !== Number(bin[11])) {
    return { ok: false, reason: "checksum" };
  }
  return { ok: true, bin };
}

/**
 * Log-safe form of a БИН (ARCHITECTURE 15.3): only the last four digits
 * survive, e.g. `********1234`.
 */
export function maskBin(bin: string): string {
  const digits = bin.replace(/\D/g, "");
  return digits.length < 8 ? "****" : `********${digits.slice(-4)}`;
}
