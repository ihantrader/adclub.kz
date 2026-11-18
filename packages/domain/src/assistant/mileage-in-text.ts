import { MILEAGE_MAX_KM } from "../garage/mileage";
import { numberWordsToDigits } from "../speech/number-words";

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
const NUMBER = String.raw`(\d{1,3}(?:[ .,]\d{3})+|\d+(?:[.,]\d+)?)`;

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

function valueOf(number: string, thousands: boolean, min: number): number | null {
  const grouped = /^\d{1,3}(?:[ .,]\d{3})+$/u.test(number);
  const plain = grouped ? number.replace(/[ .,]/gu, "") : number.replace(",", ".");
  const value = Number(plain);
  if (!Number.isFinite(value)) return null;
  const km = Math.round(thousands ? value * 1000 : value);
  return km >= min && km <= MILEAGE_MAX_KM ? km : null;
}

function isThousands(unit: string | undefined): boolean {
  // A whole word: the «k» of «km» is not thousands (TASK-060).
  return unit !== undefined && new RegExp(`^${THOUSANDS}(?!\\p{L})`, "iu").test(unit.trim());
}

/** Any number standing on its own: not a part of a word («ТО-2», «5W-30»). */
const BARE = new RegExp(String.raw`(?<![\p{L}\p{N}-])${NUMBER}(?![\p{L}\p{N}])`, "gu");

export interface MileageInTextOptions {
  /**
   * The text was said into the mileage field (TASK-060; M-GAR-07, M-REM-02):
   * the field already says it is a mileage, so a number alone counts
   * («сорок пять тысяч двести», «45 200»), if the text holds exactly one.
   */
  field?: boolean;
}

/**
 * The mileage in kilometres the text names, or `null`. A number after a
 * word of mileage wins over a number with a unit elsewhere in the text
 * («нужно ТО на 20к, пробег 18 500» — 18 500). Numbers written in words
 * («сорок пять тысяч двести», «қырық бес мың», «forty five thousand») are
 * read as their digits first (`numberWordsToDigits`, TASK-060).
 */
export function mileageInText(text: string, options: MileageInTextOptions = {}): number | null {
  const plain = text.normalize("NFKC").replace(SPACES, " ").toLowerCase();
  // The words in digits («45 тысяч двести» is 45 200, not 45 000). A number
  // that began with digits keeps the unit its word of thousands carried
  // («20 тысяч» — «20000 км»), so it counts here as it did when written
  // with digits, in the field and outside it alike (TASK-060.A).
  const digits = numberWordsToDigits(plain, { digitThousandsUnit: " км" });
  if (!options.field) return mileageByRules(digits, MILEAGE_MIN_KM);
  // In the field anything from 0 is a reading, as the field typed by hand
  // takes it (`isMileageInRange`); outside it below `MILEAGE_MIN_KM` is not.
  const numbers = [...digits.matchAll(BARE)];
  // Two numbers said («45 или 46 тысяч») — the person is asked again.
  if (numbers.length !== 1) return null;
  return mileageByRules(digits, 0) ?? valueOf(numbers[0]![1]!, false, 0);
}

/** A number after a word of mileage, or a number with a unit. */
function mileageByRules(text: string, min: number): number | null {
  for (const match of text.matchAll(WITH_WORD)) {
    const km = valueOf(match[1]!, isThousands(match[2]), min);
    if (km !== null) return km;
  }
  for (const match of text.matchAll(WITH_UNIT)) {
    const km = valueOf(match[1]!, isThousands(match[2]), min);
    if (km !== null) return km;
  }
  return null;
}
