/**
 * Numbers a person said and a model wrote as words (TASK-060; ARCHITECTURE
 * 4.91): «сорок пять тысяч двести», «қырық бес мың екі жүз», «forty five
 * thousand two hundred», «две тысячи двадцать три», «полтора». The model is
 * told to write numbers with digits; this is for when it did not.
 *
 * A run of number words becomes its value in digits; everything else of the
 * text stays as it was. Digits join a run only before a word of hundreds or
 * thousands («45 тысяч двести» — 45 200), so «2023 два литра» stays two
 * numbers. A run ends where the next word cannot continue the number («пять
 * шесть» — 5 and 6), as a person would read it.
 */

/** Below ten and the teens: a run takes one of them, last. */
const ONES: Readonly<Record<string, number>> = {
  // Russian
  // The genitive and the prepositional too («около пяти», «о двух»): they
  // follow «около», «больше», «меньше», «до», «более» (TASK-060.A).
  ноль: 0,
  нуль: 0,
  один: 1,
  одна: 1,
  одно: 1,
  одного: 1,
  одной: 1,
  одном: 1,
  два: 2,
  две: 2,
  двух: 2,
  три: 3,
  трех: 3,
  четыре: 4,
  четырех: 4,
  пять: 5,
  пяти: 5,
  шесть: 6,
  шести: 6,
  семь: 7,
  семи: 7,
  восемь: 8,
  восьми: 8,
  девять: 9,
  девяти: 9,
  десять: 10,
  десяти: 10,
  одиннадцать: 11,
  одиннадцати: 11,
  двенадцать: 12,
  двенадцати: 12,
  тринадцать: 13,
  тринадцати: 13,
  четырнадцать: 14,
  четырнадцати: 14,
  пятнадцать: 15,
  пятнадцати: 15,
  шестнадцать: 16,
  шестнадцати: 16,
  семнадцать: 17,
  семнадцати: 17,
  восемнадцать: 18,
  восемнадцати: 18,
  девятнадцать: 19,
  девятнадцати: 19,
  // Kazakh («он» is also a Russian word: see `WEAK`)
  нөл: 0,
  бір: 1,
  екі: 2,
  үш: 3,
  төрт: 4,
  бес: 5,
  алты: 6,
  жеті: 7,
  сегіз: 8,
  тоғыз: 9,
  // English
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};

/** Tens: before the ones. */
const TENS: Readonly<Record<string, number>> = {
  двадцать: 20,
  двадцати: 20,
  тридцать: 30,
  тридцати: 30,
  сорок: 40,
  сорока: 40,
  пятьдесят: 50,
  пятидесяти: 50,
  шестьдесят: 60,
  шестидесяти: 60,
  семьдесят: 70,
  семидесяти: 70,
  восемьдесят: 80,
  восьмидесяти: 80,
  девяносто: 90,
  девяноста: 90,
  он: 10,
  жиырма: 20,
  отыз: 30,
  қырық: 40,
  елу: 50,
  алпыс: 60,
  жетпіс: 70,
  сексен: 80,
  тоқсан: 90,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

/** Russian hundreds are whole words. */
const HUNDREDS: Readonly<Record<string, number>> = {
  сто: 100,
  двести: 200,
  триста: 300,
  четыреста: 400,
  пятьсот: 500,
  шестьсот: 600,
  семьсот: 700,
  восемьсот: 800,
  девятьсот: 900,
  // The genitive and the prepositional («около ста тысяч», «о двухстах»).
  ста: 100,
  двухсот: 200,
  двухстах: 200,
  трехсот: 300,
  трехстах: 300,
  четырехсот: 400,
  четырехстах: 400,
  пятисот: 500,
  пятистах: 500,
  шестисот: 600,
  шестистах: 600,
  семисот: 700,
  семистах: 700,
  восьмисот: 800,
  восьмистах: 800,
  девятисот: 900,
  девятистах: 900,
};

/** Hundreds as a multiplier of what came before («екі жүз», «two hundred»). */
const HUNDRED = new Set(["жүз", "hundred"]);

/**
 * Thousands: a multiplier of what came before («45 тысяч», «қырық мың»).
 * Only the singular stands for «one thousand» alone («тысяча», «мың»,
 * «thousand»); «тысяч», «тысячи», «тыс.» with no number before them make no
 * number («несколько тысяч» is not 1 000 — TASK-060.A).
 */
const THOUSAND = new Set(["тысяча", "тысячи", "тысяч", "тысячах", "тыс", "мың", "thousand"]);
const THOUSAND_ALONE = new Set(["тысяча", "мың", "thousand"]);

/** Kazakh number words: «он» is ten only next to one of them («он бес», «екі мың он»). */
const KAZAKH = new Set([
  "нөл",
  "бір",
  "екі",
  "үш",
  "төрт",
  "бес",
  "алты",
  "жеті",
  "сегіз",
  "тоғыз",
  "жиырма",
  "отыз",
  "қырық",
  "елу",
  "алпыс",
  "жетпіс",
  "сексен",
  "тоқсан",
  "жүз",
  "мың",
]);

/** «Полтора», «полторы» — one and a half. */
const ONE_AND_A_HALF = new Set(["полтора", "полторы"]);

/** Joins number words in English («forty and five» does not happen; «two hundred and five» does). */
const JOINERS = new Set(["and"]);

/** Number words that are also ordinary words: a number only next to another number word. */
const WEAK = new Set(["он", "one"]);

/** Classes of a word within the part below a thousand: each next one must be lower. */
type Rank = 4 | 3 | 2 | 1;

interface NumberWord {
  kind: "value" | "hundred" | "thousand";
  value: number;
  rank: Rank;
  /** A thousand that stands for «one thousand» with no number before it. */
  alone?: boolean;
  /** A Kazakh number word (for «он»). */
  kazakh?: boolean;
}

function wordKey(word: string): string {
  return word.toLowerCase().replace(/ё/gu, "е").replace(/\.$/u, "");
}

/**
 * Russian ordinals, the way a year is said («две тысячи двадцать третьего»,
 * «двадцатого года»): the stem and any ending of the word.
 */
const ORDINAL_STEMS: Readonly<Record<string, number>> = {
  перв: 1,
  втор: 2,
  трет: 3,
  четверт: 4,
  пят: 5,
  шест: 6,
  седьм: 7,
  восьм: 8,
  девят: 9,
  десят: 10,
  одиннадцат: 11,
  двенадцат: 12,
  тринадцат: 13,
  четырнадцат: 14,
  пятнадцат: 15,
  шестнадцат: 16,
  семнадцат: 17,
  восемнадцат: 18,
  девятнадцат: 19,
  двадцат: 20,
  тридцат: 30,
  сороков: 40,
  пятидесят: 50,
  шестидесят: 60,
  семидесят: 70,
  восьмидесят: 80,
  девяност: 90,
};
/** Longer stems first: «пятнадцат» before «пят». */
const ORDINAL = new RegExp(
  `^(${Object.keys(ORDINAL_STEMS)
    .sort((a, b) => b.length - a.length)
    .join("|")})(?:ый|ий|ой|ого|ому|ом|ая|ую|ое|ье|ьего|ьему|ьем|ья|ей|ем)$`,
  "u",
);

/**
 * Kazakh ordinals: the cardinal and «-ыншы/-інші/-ншы/-нші», after a vowel
 * of «жиырма» — «-сыншы» («бірінші», «екінші», «оныншы», «жиырмасыншы»).
 */
const KAZAKH_ORDINAL_SUFFIXES = ["сыншы", "сінші", "ыншы", "інші", "ншы", "нші"];

function kazakhOrdinal(key: string): number | null {
  for (const suffix of KAZAKH_ORDINAL_SUFFIXES) {
    if (!key.endsWith(suffix)) continue;
    const base = key.slice(0, -suffix.length);
    if (base === "он") return 10;
    if (KAZAKH.has(base) && base in ONES) return ONES[base]!;
    if (KAZAKH.has(base) && base in TENS) return TENS[base]!;
  }
  return null;
}

function numberWord(word: string): NumberWord | null {
  const key = wordKey(word);
  const ordinal = ORDINAL.exec(key);
  if (ordinal) {
    const value = ORDINAL_STEMS[ordinal[1]!]!;
    return { kind: "value", value, rank: value >= 20 ? 2 : 1 };
  }
  const kazakh = kazakhOrdinal(key);
  if (kazakh !== null) {
    return { kind: "value", value: kazakh, rank: kazakh >= 20 ? 2 : 1, kazakh: true };
  }
  if (THOUSAND.has(key)) {
    return {
      kind: "thousand",
      value: 1000,
      rank: 4,
      alone: THOUSAND_ALONE.has(key),
      kazakh: key === "мың",
    };
  }
  if (HUNDRED.has(key)) return { kind: "hundred", value: 100, rank: 3, kazakh: key === "жүз" };
  if (key in HUNDREDS) return { kind: "value", value: HUNDREDS[key]!, rank: 3 };
  if (key in TENS) return { kind: "value", value: TENS[key]!, rank: 2, kazakh: KAZAKH.has(key) };
  if (key in ONES) return { kind: "value", value: ONES[key]!, rank: 1, kazakh: KAZAKH.has(key) };
  if (ONE_AND_A_HALF.has(key)) return { kind: "value", value: 1.5, rank: 1 };
  return null;
}

/**
 * A word that looks like an ordinal but is not one we read («двухтысячного»,
 * «сотого»): a run of words before it is a number cut short, not a number.
 */
const UNREAD_ORDINAL = /\p{L}{3,}(?:ого|его|ый|ий|ом|ем|ыншы|інші|ншы|нші)$/u;

const DIGITS = /^\d+(?:[.,]\d+)?$/u;

/** The value of a run, or `null` when it is not one number. */
class Run {
  private total = 0;
  private current = 0;
  /** The lowest rank taken below the thousand; the next word must be lower. */
  private lowest: Rank | 5 = 5;
  /** How many tokens make up the run, and how many are words. */
  tokens = 0;
  words = 0;
  /** The run begins with digits («45 тысяч двести»). */
  digitsFirst = false;
  /** A word of thousands is in the run. */
  thousands = false;
  /** The kind of the last word taken. */
  last: NumberWord | null = null;

  /** Takes a token, or says it cannot continue this number. */
  take(word: NumberWord | null, digits: number | null): boolean {
    if (digits !== null) {
      if (this.tokens > 0) return false;
      this.current = digits;
      this.lowest = 1;
      this.tokens += 1;
      this.digitsFirst = true;
      return true;
    }
    if (!word) return false;
    if (word.kind === "thousand") {
      if (this.total > 0) return false;
      // «тысяч», «тысячи», «тыс.» alone are no number: only «тысяча», «мың», «thousand» are one.
      if (this.tokens === 0 && !word.alone) return false;
      this.total = (this.tokens === 0 ? 1 : this.current) * 1000;
      this.thousands = true;
      this.current = 0;
      this.lowest = 5;
    } else if (word.kind === "hundred") {
      if (this.lowest <= 3 && this.current >= 10) return false;
      this.current = (this.tokens === 0 || this.current === 0 ? 1 : this.current) * 100;
      this.lowest = 3;
    } else {
      if (word.rank >= this.lowest) return false;
      this.current += word.value;
      // The teens and «полтора» are of the ones: nothing below them follows.
      this.lowest = word.rank;
    }
    this.tokens += 1;
    this.words += 1;
    this.last = word;
    return true;
  }

  get value(): number {
    return this.total + this.current;
  }
}

/**
 * The text with every run of number words written in digits («сорок пять
 * тысяч двести километров» → «45200 километров»). Digits alone, with no
 * number word, stay as they were.
 */
export interface NumberWordsOptions {
  /**
   * Written right after a number that begins with digits and is multiplied
   * by a thousand («45 тысяч двести» → «45200» + this): the unit the word of
   * thousands carried, for a reader that counts a number only with its unit
   * (`mileageInText` — « км», TASK-060.A).
   */
  digitThousandsUnit?: string;
}

export function numberWordsToDigits(text: string, options: NumberWordsOptions = {}): string {
  // Words with what stands between them, so the rest of the text is kept as it was.
  const parts = text.split(/(\s+)/u);
  const out: string[] = [];
  let index = 0;
  while (index < parts.length) {
    const part = parts[index]!;
    if (/^\s*$/u.test(part)) {
      out.push(part);
      index += 1;
      continue;
    }
    const found = runAt(parts, index);
    if (!found) {
      out.push(part);
      index += 1;
      continue;
    }
    const unit = found.digitThousands ? (options.digitThousandsUnit ?? "") : "";
    out.push(String(found.value) + unit + found.tail);
    index = found.next;
  }
  return out.join("");
}

/** A sign after a word («двести,»): it ends the run and stays after the digits. */
const TRAILING_SIGN = /[,;:!?)»"]+$/u;

/**
 * A run of number words starting at `index` of `parts` (words and spaces in
 * turn): its value, the sign after it, and the index of the first part after it.
 */
function runAt(
  parts: readonly string[],
  index: number,
): { value: number; tail: string; next: number; digitThousands: boolean } | null {
  const run = new Run();
  let next = index;
  let tail = "";
  let strong = false;
  for (let at = index; at < parts.length; at += 2) {
    const raw = parts[at]!;
    const sign = TRAILING_SIGN.exec(raw)?.[0] ?? "";
    const word = sign ? raw.slice(0, -sign.length) : raw;
    // A joiner is taken only when a number word follows it («two hundred and five»).
    if (run.tokens > 0 && !sign && JOINERS.has(wordKey(word))) continue;
    // «сорок-пять», «forty-five».
    const pieces = word.split("-");
    const tokens =
      pieces.length > 1 && pieces.every((piece) => numberWord(piece) !== null) ? pieces : [word];
    let took = true;
    for (const token of tokens) {
      if (DIGITS.test(token)) {
        // Digits join only before a word of hundreds or thousands: «45 тысяч».
        const following = parts[at + 2]?.replace(TRAILING_SIGN, "");
        const after = following === undefined || sign ? null : numberWord(following);
        took =
          after !== null &&
          after.kind !== "value" &&
          run.take(null, Number(token.replace(",", ".")));
      } else {
        // «он» is ten only next to a Kazakh number word («он бес», «екі мың он»),
        // never before a Russian one («он пять тысяч прошёл» — TASK-060.A).
        if (wordKey(token) === "он" && !run.last?.kazakh && !kazakhNext(parts, at, sign)) {
          took = false;
          break;
        }
        took = run.take(numberWord(token), null);
        if (took && !WEAK.has(wordKey(token))) strong = true;
      }
      if (!took) break;
    }
    if (!took) break;
    next = at + 1;
    tail = sign;
    if (sign) break;
  }
  if (run.words === 0) return null;
  // «он», «one» alone are ordinary words.
  if (!strong && run.tokens === 1) return null;
  // «две тысячи двухтысячного»: an ordinal we do not read cut the number
  // short — no number rather than 2000 (TASK-060.A).
  const last = run.last;
  if (!tail && last && (last.kind !== "value" || last.rank >= 3)) {
    const following = parts[next + 1];
    const key = following === undefined ? "" : wordKey(following.replace(TRAILING_SIGN, ""));
    if (UNREAD_ORDINAL.test(key) && numberWord(key) === null) return null;
  }
  return { value: run.value, tail, next, digitThousands: run.digitsFirst && run.thousands };
}

/** The word after `at` is a Kazakh number word. */
function kazakhNext(parts: readonly string[], at: number, sign: string): boolean {
  if (sign) return false;
  const following = parts[at + 2]?.replace(TRAILING_SIGN, "");
  if (following === undefined) return false;
  return numberWord(following)?.kazakh === true;
}
