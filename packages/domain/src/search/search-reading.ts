import { normalizeSearchText, searchKey, type SearchVariant } from "./search-query";

/**
 * What a query was read as, when the search index forgave it something
 * (TASK-045; SCREENS T-CAT-08 «Показаны результаты по «…»»): a typo («колодкм»
 * found «колодки»), or a word none of the found texts has. Worked out from
 * the texts of what was found, not from the index, so the same function
 * serves whatever finds: the reading is what a person would recognise in
 * the results.
 */

/** Words shorter than this are never read as typos (as the index: one typo from five letters). */
export const READING_ONE_TYPO_MIN = 5;
/** Two typos from this many letters. */
export const READING_TWO_TYPOS_MIN = 9;

/** The edit distance with transpositions (optimal string alignment). */
export function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const columns = b.length + 1;
  const table: number[][] = Array.from({ length: rows }, (_, row) =>
    Array.from({ length: columns }, (_, column) => (row === 0 ? column : column === 0 ? row : 0)),
  );
  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const cost = a[row - 1] === b[column - 1] ? 0 : 1;
      let best = Math.min(
        table[row - 1]![column]! + 1,
        table[row]![column - 1]! + 1,
        table[row - 1]![column - 1]! + cost,
      );
      if (row > 1 && column > 1 && a[row - 1] === b[column - 2] && a[row - 2] === b[column - 1]) {
        best = Math.min(best, table[row - 2]![column - 2]! + 1);
      }
      table[row]![column] = best;
    }
  }
  return table[a.length]![b.length]!;
}

function typosAllowed(word: string): number {
  return word.length >= READING_TWO_TYPOS_MIN ? 2 : word.length >= READING_ONE_TYPO_MIN ? 1 : 0;
}

interface TextWord {
  /** As read (`normalizeSearchText`), Kazakh letters kept. */
  text: string;
  /** As compared (`searchKey`). */
  key: string;
}

/**
 * The words of texts, each as read and as compared (the two forms align word
 * by word), and every two neighbours joined — the index reads «5w30» as
 * «5W-30» and «5w 30» as «5W30».
 */
function wordsOf(texts: readonly string[]): TextWord[] {
  const words: TextWord[] = [];
  for (const value of texts) {
    const read = normalizeSearchText(value).split(" ");
    const keys = searchKey(value).split(" ");
    const aligned = read.length === keys.length;
    const own = keys
      .map((key, index) => ({ text: aligned ? read[index]! : key, key }))
      .filter((word) => word.key !== "");
    words.push(...own);
    for (let index = 0; index + 1 < own.length; index += 1) {
      words.push({
        text: `${own[index]!.text}${own[index + 1]!.text}`,
        key: `${own[index]!.key}${own[index + 1]!.key}`,
      });
    }
  }
  return words;
}

export interface SearchReading {
  /** The words kept and corrected, as a person reads them; the variant's text when none is kept. */
  text: string;
  /** How many words of the variant are in the texts, as typed or with a typo forgiven. */
  kept: number;
}

/**
 * The reading of a variant of the query by the texts of what was found:
 * every word that begins a word of the texts stays as typed; a word within
 * the typos the index forgives of a word of the texts (or of its beginning:
 * the last word is a prefix) becomes that word; a word nothing is near is
 * left out. A thing none of whose words is kept was not really found (the
 * index may drop words and forgive more than a person would): the search
 * leaves it out.
 */
export function searchReading(variant: SearchVariant, texts: readonly string[]): SearchReading {
  const words = wordsOf(texts);
  const typed = variant.text.split(" ");
  const keys = variant.key.split(" ");
  const aligned = typed.length === keys.length;
  const read: string[] = [];
  for (const [index, key] of keys.entries()) {
    if (key === "") {
      continue;
    }
    const asTyped = aligned ? typed[index]! : key;
    if (words.some((word) => word.key.startsWith(key))) {
      read.push(asTyped);
      continue;
    }
    const allowed = typosAllowed(key);
    let best: { word: TextWord; distance: number } | null = null;
    for (const word of words) {
      const distance = Math.min(
        editDistance(key, word.key),
        editDistance(key, word.key.slice(0, key.length)),
      );
      if (distance <= allowed && (best === null || distance < best.distance)) {
        best = { word, distance };
      }
    }
    if (best) {
      read.push(best.word.text);
    }
  }
  return { text: read.length === 0 ? variant.text : read.join(" "), kept: read.length };
}
