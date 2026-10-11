import { normalizeArticle } from "../article/normalize-article";

/**
 * How a query of the user's search is read (TASK-044; ARCHITECTURE 10.2):
 * one set of pure functions for every search of the project — the users'
 * search (`GET /catalog/search`), the supplier's search of an item for an
 * offer and the administrator's search of items.
 *
 * Two forms of a text:
 *
 * - the **text** (`normalizeSearchText`) — what a person reads: lower case,
 *   `ё → е`, every hyphen, dot, comma and other sign a space, spaces
 *   collapsed; Kazakh letters kept («тежегіш қалыптары»). T-CAT-08 shows it.
 * - the **key** (`searchKey`) — what is compared: the text with the Kazakh
 *   letters folded into the Russian ones a person types without a Kazakh
 *   keyboard (`ә → а`, `қ → к`, `і → и`…), so «тежегиш» finds «тежегіш». The
 *   database computes the very same key — `search_key(text)` of the migration
 *   `…_catalog-search.sql`; the integration test compares them.
 */

/** At most this many variants of one query (ARCHITECTURE 10.2 п. 3). */
export const SEARCH_VARIANTS_MAX = 4;
/** An article: at least this many letters and digits once separators are gone, one a digit. */
export const ARTICLE_QUERY_MIN_LENGTH = 5;
/** Words of one query that are compared; the rest are ignored. */
export const SEARCH_WORDS_MAX = 8;

/** Kazakh letters and the Russian ones typed in their place. */
export const KAZAKH_FOLD: Readonly<Record<string, string>> = {
  ә: "а",
  ғ: "г",
  қ: "к",
  ң: "н",
  ө: "о",
  ұ: "у",
  ү: "у",
  һ: "х",
  і: "и",
};

const NOT_TEXT = /[^0-9a-zа-яәғқңөұүһі]+/g;
const NOT_KEY = /[^0-9a-zа-я]+/g;
const LATIN = /[a-z]/;
const CYRILLIC = /[а-яёәғқңөұүһі]/;

/** The text of a query or of a name as a person reads it. */
export function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/ё/g, "е").replace(NOT_TEXT, " ").trim();
}

/** The key a text is compared by: the text with Kazakh letters folded (see the module). */
export function searchKey(value: string): string {
  return normalizeSearchText(value)
    .replace(/[әғқңөұүһі]/g, (letter) => KAZAKH_FOLD[letter]!)
    .replace(NOT_KEY, " ")
    .trim();
}

/**
 * The article a query may be (ARCHITECTURE 10.2 п. 2): after removing spaces,
 * hyphens, dots and other signs (`normalizeArticle`) — at least five letters
 * and digits, one of them a digit. `null` — not an article. The text branch
 * runs for such a query too: «масло 5w-30» looks like an article and is a name.
 */
export function articleQuery(value: string): string | null {
  const norm = normalizeArticle(value);
  return norm.length >= ARTICLE_QUERY_MIN_LENGTH && /\d/.test(norm) ? norm : null;
}

// ----------------------------------------------------------- keyboard layouts

/**
 * The same keys of the English (QWERTY) and the Russian (ЙЦУКЕН) layouts,
 * with the shifted signs that stand for letters there («;» is «ж»).
 */
const EN_KEYS = "qwertyuiop[]asdfghjkl;'zxcvbnm,.`{}:\"<>~";
const RU_KEYS = "йцукенгшщзхъфывапролджэячсмитьбюёхъжэбюё";

const EN_TO_RU = new Map<string, string>();
const RU_TO_EN = new Map<string, string>();
for (let index = 0; index < EN_KEYS.length; index += 1) {
  const en = EN_KEYS[index]!;
  const ru = RU_KEYS[index]!;
  EN_TO_RU.set(en, ru);
  if (!RU_TO_EN.has(ru)) {
    RU_TO_EN.set(ru, en);
  }
}

/**
 * The number row of the Kazakh layout (Windows «Казахская»): the keys that
 * type digits in the Russian and the English layouts type the Kazakh letters
 * there — «2» is «ә», «3» is «і», «0» is «қ».
 */
const KAZAKH_ROW: Readonly<Record<string, string>> = {
  "2": "ә",
  "3": "і",
  "4": "ң",
  "5": "ғ",
  "8": "ү",
  "9": "ұ",
  "0": "қ",
  "-": "ө",
  "=": "һ",
};

/** What the keys pressed in the English layout type in the Russian one («rjkjlrb» → «колодки»). */
export function englishLayoutToRussian(value: string): string {
  return [...value.toLowerCase()].map((char) => EN_TO_RU.get(char) ?? char).join("");
}

/** What the keys pressed in the Russian layout type in the English one («ыещз» → «stop»). */
export function russianLayoutToEnglish(value: string): string {
  return [...value.toLowerCase()].map((char) => RU_TO_EN.get(char) ?? char).join("");
}

/**
 * A Kazakh word typed in the Russian or the English layout: the digits inside
 * a word that has Cyrillic letters are the Kazakh letters of their keys
 * («тежег3ш» → «тежегіш»). A word without Cyrillic letters («5w-30») stays.
 */
export function kazakhLayoutLetters(value: string): string {
  return value
    .toLowerCase()
    .split(/(\s+)/)
    .map((word) =>
      CYRILLIC.test(word) && /[0-9]/.test(word)
        ? [...word].map((char) => KAZAKH_ROW[char] ?? char).join("")
        : word,
    )
    .join("");
}

// ----------------------------------------------------------- transliteration

const LATIN_CLUSTERS: readonly (readonly [string, string])[] = [
  ["shch", "щ"],
  ["sch", "щ"],
  ["zh", "ж"],
  ["kh", "х"],
  ["ch", "ч"],
  ["sh", "ш"],
  ["ts", "ц"],
  ["yu", "ю"],
  ["ya", "я"],
  ["yo", "е"],
];

const LATIN_LETTERS: Readonly<Record<string, string>> = {
  a: "а",
  b: "б",
  c: "к",
  d: "д",
  e: "е",
  f: "ф",
  g: "г",
  h: "х",
  i: "и",
  j: "дж",
  k: "к",
  l: "л",
  m: "м",
  n: "н",
  o: "о",
  p: "п",
  q: "к",
  r: "р",
  s: "с",
  t: "т",
  u: "у",
  v: "в",
  w: "в",
  x: "кс",
  z: "з",
};

const CYRILLIC_LETTERS: Readonly<Record<string, string>> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "h",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "shch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
  ә: "a",
  ғ: "g",
  қ: "k",
  ң: "n",
  ө: "o",
  ұ: "u",
  ү: "u",
  һ: "h",
  і: "i",
};

const VOWELS = "аеиоуыэюяё";

/** Latin letters in Cyrillic («kolodki» → «колодки»); Cyrillic letters stay. */
export function latinToCyrillic(value: string): string {
  const text = value.toLowerCase();
  let result = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    // «y» after a vowel is «й» («toyota» → «тойота»), never the start of «я», «ю».
    if (char === "y" && VOWELS.includes(result.at(-1) ?? "")) {
      result += "й";
      index += 1;
      continue;
    }
    const cluster = LATIN_CLUSTERS.find(([latin]) => text.startsWith(latin, index));
    if (cluster) {
      result += cluster[1];
      index += cluster[0].length;
      continue;
    }
    result += char === "y" ? "ы" : (LATIN_LETTERS[char] ?? char);
    index += 1;
  }
  return result;
}

/** Cyrillic letters (Russian and Kazakh) in Latin («шелл» → «shell»); Latin letters stay. */
export function cyrillicToLatin(value: string): string {
  return [...value.toLowerCase()].map((char) => CYRILLIC_LETTERS[char] ?? char).join("");
}

// ------------------------------------------------------------------ variants

export interface SearchVariant {
  /** As a person reads it (T-CAT-08: «Показаны результаты по «колодки»»). */
  text: string;
  /** What is compared (`searchKey`). */
  key: string;
  /** The beginnings of words a matching text must have, one per word (`searchStems`). */
  stems: string[];
}

const CYRILLIC_ENDING = /[аеиоуыэюяйь]$/;

/**
 * The beginnings of the words of a key a text must have, in order, without
 * repeats. A Russian word of five letters and more loses up to two of its
 * final vowels (and «й», «ь») — a poor man's stem, so «масло» finds
 * «масла», «тормозные» — «тормозной» — and keeps at least four; an English
 * word of four letters and more loses a final «s» («pads» finds «pad»).
 * Digits and short words stay whole.
 */
export function searchStems(key: string): string[] {
  const stems: string[] = [];
  for (const word of key.split(" ")) {
    if (word === "") {
      continue;
    }
    let stem = word;
    if (/^[а-я]+$/.test(word)) {
      for (let cut = 0; cut < 2 && stem.length > 4 && CYRILLIC_ENDING.test(stem); cut += 1) {
        stem = stem.slice(0, -1);
      }
    } else if (/^[a-z]+$/.test(word) && word.length >= 4 && word.endsWith("s")) {
      stem = word.slice(0, -1);
    }
    if (!stems.includes(stem)) {
      stems.push(stem);
    }
  }
  return stems.slice(0, SEARCH_WORDS_MAX);
}

/** A variant of the given text, or `null` when nothing of it is left to search. */
export function searchVariant(value: string): SearchVariant | null {
  const text = normalizeSearchText(value);
  const key = searchKey(value);
  return key === "" ? null : { text, key, stems: searchStems(key) };
}

/**
 * The variants of a query (ARCHITECTURE 10.2 п. 3), at most four, without
 * repeats, the query itself first:
 *
 * 1. the query as typed;
 * 2. typed in the wrong layout — Latin keys read in the Russian layout
 *    («rjkjlrb» → «колодки»), Cyrillic keys read in the English one
 *    («ыещз» → «stop»);
 * 3. a Kazakh word typed without the Kazakh layout (digits of the number row
 *    inside a Cyrillic word: «тежег3ш» → «тежегіш»);
 * 4. transliterated — Latin in Cyrillic («kolodki» → «колодки»), Cyrillic in
 *    Latin («шелл» → «shell»).
 *
 * Two variants are one when their keys are equal.
 */
export function searchVariants(query: string): SearchVariant[] {
  const lower = query.toLowerCase();
  const candidates: string[] = [lower];
  const hasLatin = LATIN.test(lower);
  const hasCyrillic = CYRILLIC.test(lower);
  if (hasLatin) {
    candidates.push(englishLayoutToRussian(lower));
  }
  if (hasCyrillic) {
    candidates.push(russianLayoutToEnglish(lower));
  }
  const kazakh = kazakhLayoutLetters(lower);
  if (kazakh !== lower) {
    candidates.push(kazakh);
  } else if (hasLatin) {
    const switched = kazakhLayoutLetters(englishLayoutToRussian(lower));
    if (switched !== englishLayoutToRussian(lower)) {
      candidates.push(switched);
    }
  }
  if (hasLatin) {
    candidates.push(latinToCyrillic(lower));
  }
  if (hasCyrillic) {
    candidates.push(cyrillicToLatin(lower));
  }
  const variants: SearchVariant[] = [];
  for (const candidate of candidates) {
    const variant = searchVariant(candidate);
    if (variant && !variants.some((known) => known.key === variant.key)) {
      variants.push(variant);
    }
    if (variants.length === SEARCH_VARIANTS_MAX) {
      break;
    }
  }
  return variants;
}

// ------------------------------------------------------------------ matching

/** A text of a thing found by search: its own name or synonym (`own`), or of its category or brand. */
export interface SearchDocument {
  /** `searchKey` of the text. */
  key: string;
  own: boolean;
}

export type SearchTextMatch = "exact" | "partial";

export interface SearchDocumentsMatch {
  match: SearchTextMatch;
  /** The item's own names and synonyms matched by themselves, not with its category or brand. */
  own: boolean;
  /** Which variant matched (0 — the query as typed). */
  variant: number;
}

function hasStems(text: string, stems: readonly string[]): boolean {
  const padded = ` ${text}`;
  return stems.every((stem) => padded.includes(` ${stem}`));
}

/**
 * Whether the texts of a thing match a query, and how (ARCHITECTURE 10.2;
 * TASK-044): `exact` — one of its texts is the variant itself (a name, a
 * synonym, the name or a synonym of its category, a spelling of its brand);
 * `partial` — every word of the variant begins a word of its texts taken
 * together («масло shell»: the category and the brand). The best of the
 * variants; of equals — the earlier one. `null` — no match.
 */
export function matchSearchDocuments(
  variants: readonly SearchVariant[],
  documents: readonly SearchDocument[],
): SearchDocumentsMatch | null {
  let best: SearchDocumentsMatch | null = null;
  const all = documents.map((document) => document.key).join(" ");
  const own = documents
    .filter((document) => document.own)
    .map((document) => document.key)
    .join(" ");
  for (const [index, variant] of variants.entries()) {
    const exact = documents.find((document) => document.key === variant.key);
    let found: SearchDocumentsMatch | null = null;
    if (exact) {
      found = { match: "exact", own: exact.own, variant: index };
    } else if (variant.stems.length > 0 && hasStems(all, variant.stems)) {
      found = { match: "partial", own: hasStems(own, variant.stems), variant: index };
    }
    if (found && (best === null || searchMatchRank(found) < searchMatchRank(best))) {
      best = found;
    }
  }
  return best;
}

function searchMatchRank(found: SearchDocumentsMatch): number {
  return (found.match === "exact" ? 0 : 2) + (found.own ? 0 : 1);
}
