import { MILEAGE_MAX_KM } from "../garage/mileage";

/**
 * The mileage a person named in a message to the assistant (TASK-062;
 * ARCHITECTURE 18.6): «ТО-2, пробег 20 000», «20к», «45 200 км», «пробег
 * 20 мың», «mileage 20k». The assistant never writes it — the app is told
 * the number and asks the person to confirm it, and only then writes it the
 * way every reading is written (`POST /garage/cars/{id}/mileage`, TASK-058).
 *
 * A number counts only when the message says it is a mileage: a unit of
 * distance or of thousands after it («км», «km», «к», «тыс», «мың»), or a
 * word of mileage before it («пробег», «mileage», «жүріс»). «ТО-2», «4 л»,
 * «5W-30» and a year are not mileage. Below `MILEAGE_MIN_KM` is not
 * believable as a car's mileage and is not offered.
 */

/** Less than this is not offered as a mileage («2к» is more likely a price in thousands). */
export const MILEAGE_MIN_KM = 100;

/** Spaces of every kind, as people and keyboards type them. */
const SPACES = /[\u00a0\u2000-\u200b\u202f\u205f\u3000]/gu;

/** A number as people write it: digits, optionally grouped by spaces or dots («20 000», «20.000»). */
const NUMBER = String.raw`(\d{1,3}(?:[ .]\d{3})+|\d+(?:[.,]\d+)?)`;

/** Thousands: «к», «k», «тыс», «тысяч», «мың», «thousand». */
const THOUSANDS = String.raw`(?:к|k|тыс\.?|тысяч[а-я]*|мың|thousand|thousands)`;

/** Kilometres: «км», «km», «километр…». */
const KILOMETRES = String.raw`(?:км|km|километр[а-я]*|kilomet(?:er|re)s?|шақырым)`;

/** Words that say the number after them is the mileage. */
const MILEAGE_WORDS = String.raw`(?:пробег[а-я]*|mileage|odometer|одометр[а-я]*|жүріс[а-яәғқңөұүһі]*|жүрген)`;

/** No letter right after: «20 км» but not «20 кмх», «20к» but not «20 канистр». */
const END = String.raw`(?![\p{L}\p{N}])`;

const WITH_WORD = new RegExp(
  String.raw`${MILEAGE_WORDS}[^\p{N}]{0,12}${NUMBER}\s*(${THOUSANDS})?${END}`,
  "giu",
);
const WITH_UNIT = new RegExp(
  String.raw`(?<![\p{L}\p{N}-])${NUMBER}\s*(${THOUSANDS}\s*(?:${KILOMETRES})?|${KILOMETRES})${END}`,
  "giu",
);

function valueOf(number: string, thousands: boolean): number | null {
  const grouped = /^\d{1,3}(?:[ .]\d{3})+$/u.test(number);
  const plain = grouped ? number.replace(/[ .]/gu, "") : number.replace(",", ".");
  const value = Number(plain);
  if (!Number.isFinite(value)) return null;
  const km = Math.round(thousands ? value * 1000 : value);
  return km >= MILEAGE_MIN_KM && km <= MILEAGE_MAX_KM ? km : null;
}

function isThousands(unit: string | undefined): boolean {
  return unit !== undefined && new RegExp(`^${THOUSANDS}`, "iu").test(unit.trim());
}

/**
 * The mileage in kilometres the text names, or `null`. A number after a
 * word of mileage wins over a number with a unit elsewhere in the text
 * («нужно ТО на 20к, пробег 18 500» — 18 500).
 */
export function mileageInText(text: string): number | null {
  const normalized = text.normalize("NFKC").replace(SPACES, " ").toLowerCase();
  for (const match of normalized.matchAll(WITH_WORD)) {
    const km = valueOf(match[1]!, isThousands(match[2]));
    if (km !== null) return km;
  }
  for (const match of normalized.matchAll(WITH_UNIT)) {
    const km = valueOf(match[1]!, isThousands(match[2]));
    if (km !== null) return km;
  }
  return null;
}
