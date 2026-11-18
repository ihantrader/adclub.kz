import { cyrillicToLatin, latinToCyrillic } from "../search/search-query";
import { numberWordsToDigits } from "../speech/number-words";
import { engineVolumeCc } from "./vehicle-document";

/**
 * A car a person named by voice (TASK-060; SCREENS M-START-05, M-GAR-02;
 * ARCHITECTURE 4.91): «Geely Atlas 2023, 1,5 турбо», «Джили Атлас две тысячи
 * двадцать третьего», «белый Кулрей 2024». The phrase is taken apart here —
 * the year, the engine size, the words left to name the make and the model
 * — and the server places those words in the vehicle catalog by every
 * spelling it keeps and by the transliteration of the search.
 */

export interface VehiclePhrase {
  /** The last of `years` («Geely 2099 Atlas 2023» — 2023), or `null`. */
  year: number | null;
  /**
   * Every four digits from 1950 to the current year, in the order said
   * (TASK-060.A): one of them may be the name of a model («Peugeot 2008
   * 2020»), and only the server knows the catalog — `vehicleYearOf`.
   */
  years: number[];
  /** The words said, with the years among them in their places (to place a model named by digits). */
  wordsWithYears: string[];
  /** The engine size in cm³ («1.5», «1,5 л», «полтора литра» — 1500). */
  engineVolumeCc: number | null;
  /** The words left, in the order said, to name the make and the model. */
  words: string[];
}

/** A run of the words left that may be a make or a model, and its spellings to look up. */
export interface VehicleNameSpan {
  /** The words as said («Атлас Про»). */
  text: string;
  /** The first word of the run and the word after its last. */
  from: number;
  to: number;
  /** The text, in Latin and in Cyrillic letters (`cyrillicToLatin`, `latinToCyrillic`), without repeats. */
  spellings: string[];
}

/** The oldest year a phrase names; the catalog has nothing older. */
const OLDEST_YEAR = 1950;

/** The most words a make or a model is named by («Tiggo 7 Pro»). */
export const VEHICLE_NAME_MAX_WORDS = 3;

/** «2023», «2023-го», «2023 года» — not a part of a longer number. */
const YEAR = /(?<![\d.,])((?:19|20)\d\d)(?![\d.,]?\d)/gu;

/** «1.5», «1,5», «2.0T» — one digit, a point or a comma, one digit. */
const VOLUME_POINT = /(?<![\d.,])(\d)[.,](\d)(?![\d.,]?\d)/u;
/**
 * «2 литра», «2 liters» — a whole number of litres only with the whole word:
 * «7 л» and the «7» of «Tiggo 7 Pro» are no engine size (TASK-060.A).
 */
const VOLUME_LITRES =
  /(?<![\d.,])([1-8])\s*(?:литр[а-я]*|литрлік|liter|liters|litre|litres)(?![\p{L}\p{N}])/iu;

/** Words that say nothing of the make or the model. */
const FILLER = new Set([
  // Russian
  "у",
  "меня",
  "мой",
  "моя",
  "это",
  "машина",
  "автомобиль",
  "авто",
  "год",
  "года",
  "году",
  "г",
  "го",
  "выпуска",
  "л",
  "литр",
  "литра",
  "литров",
  "турбо",
  "двигатель",
  "мотор",
  "объем",
  "объём",
  "и",
  "на",
  // Kazakh
  "менің",
  "көлігім",
  "көлік",
  "машинам",
  "жыл",
  "жылы",
  "жылғы",
  "литрлік",
  "қозғалтқыш",
  // English
  "my",
  "car",
  "a",
  "the",
  "is",
  "i",
  "have",
  "year",
  "liter",
  "litre",
  "l",
  "turbo",
  "t",
  "engine",
]);

/** The phrase taken apart: the year and the engine size out, the words left in order. */
export function readVehiclePhrase(text: string, currentYear: number): VehiclePhrase {
  let withYears = numberWordsToDigits(text.normalize("NFKC").replace(/\s+/gu, " "));

  // Every year said, not the first four digits: «Geely 2099 Atlas 2023» is 2023.
  const found = [...withYears.matchAll(YEAR)].filter((match) => {
    const value = Number(match[1]);
    return value >= OLDEST_YEAR && value <= currentYear;
  });
  const years = found.map((match) => Number(match[1]));
  let rest = withYears;
  for (const match of [...found].reverse()) rest = cut(rest, match.index, match[0].length);

  let engineVolume: number | null = null;
  const volumeIn = (source: string) => VOLUME_POINT.exec(source) ?? VOLUME_LITRES.exec(source);
  const volumeMatch = volumeIn(rest);
  if (volumeMatch) {
    const litres = Number(`${volumeMatch[1]!}.${volumeMatch[2] ?? "0"}`);
    engineVolume = engineVolumeCc(litres);
    if (engineVolume !== null) {
      rest = cut(rest, volumeMatch.index, volumeMatch[0].length);
      const again = volumeIn(withYears);
      if (again) withYears = cut(withYears, again.index, again[0].length);
    }
  }

  return {
    year: years.at(-1) ?? null,
    years,
    engineVolumeCc: engineVolume,
    words: wordsOf(rest),
    wordsWithYears: wordsOf(withYears),
  };
}

/** The words that may name a make or a model, in the order said. */
function wordsOf(text: string): string[] {
  return (
    text
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word !== "")
      .filter((word) => !FILLER.has(word.toLowerCase().replace(/ё/gu, "е")))
      // One letter or a number left alone names nothing («7» of «Tiggo 7 Pro» stays with its words).
      .filter((word, index, all) => word.length > 1 || hasLetterNeighbour(all, index))
  );
}

/**
 * The year of the car once the model is known (TASK-060.A): the last of the
 * years said that is not a word of the model's name as said («Peugeot 2008
 * 2020» with the model «2008» — 2020), or `null`.
 */
export function vehicleYearOf(years: readonly number[], modelSaid: string | null): number | null {
  const taken = new Set((modelSaid ?? "").split(/[^\p{L}\p{N}]+/u));
  return years.filter((year) => !taken.has(String(year))).at(-1) ?? null;
}

function cut(text: string, index: number, length: number): string {
  return `${text.slice(0, index)} ${text.slice(index + length)}`;
}

function hasLetterNeighbour(words: readonly string[], index: number): boolean {
  if (!/^\p{N}$/u.test(words[index]!)) return false;
  return [words[index - 1], words[index + 1]].some(
    (word) => word !== undefined && /\p{L}/u.test(word),
  );
}

/** A name as said, in Latin and in Cyrillic letters, without repeats («Атлас» — «atlas»). */
export function vehicleNameSpellings(text: string): string[] {
  return [...new Set([text, cyrillicToLatin(text), latinToCyrillic(text)])];
}

/**
 * Every run of the words that may name a make or a model: longer runs
 * first («Atlas Pro» before «Atlas»), then in the order said, each with its
 * spellings in both alphabets («Атлас» — «atlas»; «Coolray» — «коолрай»).
 * `exclude` — the words already taken (the make, when the model is looked up).
 */
export function vehicleNameSpans(
  words: readonly string[],
  exclude: { from: number; to: number } | null = null,
): VehicleNameSpan[] {
  const spans: VehicleNameSpan[] = [];
  for (let size = Math.min(VEHICLE_NAME_MAX_WORDS, words.length); size >= 1; size -= 1) {
    for (let from = 0; from + size <= words.length; from += 1) {
      const to = from + size;
      if (exclude && from < exclude.to && to > exclude.from) continue;
      const text = words.slice(from, to).join(" ");
      spans.push({ text, from, to, spellings: vehicleNameSpellings(text) });
    }
  }
  return spans;
}
