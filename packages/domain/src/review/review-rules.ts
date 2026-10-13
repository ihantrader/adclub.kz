import { warrantyTextContacts, type WarrantyContactKind } from "../offer/warranty-text";
import { cyrillicToLatin, latinToCyrillic, searchKey } from "../search/search-query";

/**
 * The deterministic part of the check of a review (TASK-049 requirement 1;
 * ARCHITECTURE 4.69): what is found without AI, and when anything is, AI is
 * not asked at all.
 *
 * - `contacts` — a phone, a link, an e-mail, by the very function that
 *   guards the warranty text of an offer (`warrantyTextContacts`, one
 *   detector of contacts in the project);
 * - `supplier_name` — the name of the order's supplier, in any case, in
 *   Latin or Cyrillic letters, with Kazakh letters typed as Russian ones and
 *   with Russian endings («в Автомаркете»), written apart or together («Авто
 *   маркет»); the legal form («ТОО», «ИП», «ЖШС», «LLP») is not part of it;
 * - `employee_name` — a name of the supplier's employees (a word of it, of
 *   three letters and more: «менеджер Айгерим»).
 *
 * The check does not refuse: a finding holds the review for an
 * administrator, who may still publish it (a positive review naming the
 * supplier is held too — that is the rule).
 */

export type ReviewRuleFinding =
  | { kind: "contacts"; contacts: WarrantyContactKind[] }
  | { kind: "supplier_name" }
  | { kind: "employee_name" };

export interface ReviewRuleContext {
  /** The supplier's names: its name (and any other spelling of it). */
  supplierNames: readonly string[];
  /** The names of its employees and of its contact person. */
  employeeNames: readonly string[];
}

/** Legal forms that are not part of a company's name, as keys (`searchKey`). */
const LEGAL_FORMS = new Set([
  "тоо",
  "ип",
  "ао",
  "оао",
  "зао",
  "ооо",
  "чп",
  "жшс",
  "жк",
  "кх",
  "llp",
  "llc",
  "ltd",
  "jsc",
  "inc",
  "too",
  "ip",
]);

/** A word of a name shorter than this is matched only as a whole word. */
const STEM_MIN = 5;
/** A Russian ending a word of a name may gain in a text («Автомаркет» → «Автомаркетом»). */
const ENDING_MAX = 3;
/** A name of an employee: words shorter than this are not looked for (initials, «Ли»). */
const PERSON_WORD_MIN = 3;
/** A company's name written together is looked for inside the text only from this length. */
const JOINED_MIN = 6;

const VOWEL_END = /[аеиоуыэюяйьaeiouy]$/;

/**
 * The forms a text is compared in: as written, in Latin letters, in Cyrillic
 * letters, and in Latin letters with «y» and «j» read as «i» — «Aigerim»,
 * «Aygerim» and «Айгерим» are one name.
 */
function forms(value: string): string[] {
  const latin = searchKey(cyrillicToLatin(value));
  const all = [
    searchKey(value),
    latin,
    searchKey(latinToCyrillic(value)),
    latin.replace(/[yj]/g, "i"),
  ];
  return [...new Set(all.filter((form) => form !== ""))];
}

function wordsOf(key: string): string[] {
  return key.split(" ").filter((word) => word !== "");
}

/** The beginning a longer word of a name must start a word of the text with. */
function stemOf(word: string): string {
  let stem = word;
  for (let cut = 0; cut < 2 && stem.length > STEM_MIN - 1 && VOWEL_END.test(stem); cut += 1) {
    stem = stem.slice(0, -1);
  }
  return stem;
}

/** A word of the text is this word of a name: the same, or the same with a Russian ending. */
function wordMatches(textWord: string, nameWord: string): boolean {
  if (textWord === nameWord) {
    return true;
  }
  if (nameWord.length < STEM_MIN || /\d/.test(nameWord)) {
    return false;
  }
  const stem = stemOf(nameWord);
  return textWord.startsWith(stem) && textWord.length <= nameWord.length + ENDING_MAX;
}

/** The words of the name stand one after another somewhere in the words of the text. */
function sequenceIn(textWords: readonly string[], nameWords: readonly string[]): boolean {
  if (nameWords.length === 0) {
    return false;
  }
  for (let start = 0; start + nameWords.length <= textWords.length; start += 1) {
    if (nameWords.every((word, index) => wordMatches(textWords[start + index]!, word))) {
      return true;
    }
  }
  return false;
}

function companyNameIn(textForms: readonly string[], name: string): boolean {
  for (const nameForm of forms(name)) {
    const nameWords = wordsOf(nameForm).filter((word) => !LEGAL_FORMS.has(word));
    if (nameWords.length === 0) {
      continue;
    }
    const joined = nameWords.join("");
    for (const textForm of textForms) {
      const textWords = wordsOf(textForm);
      if (sequenceIn(textWords, nameWords)) {
        return true;
      }
      // «Авто маркет» for «Автомаркет», «автомаркет» for «Авто Маркет».
      if (joined.length >= JOINED_MIN && textWords.join("").includes(joined)) {
        return true;
      }
    }
  }
  return false;
}

function personNameIn(textForms: readonly string[], name: string): boolean {
  for (const nameForm of forms(name)) {
    for (const word of wordsOf(nameForm)) {
      if (word.length < PERSON_WORD_MIN || /\d/.test(word)) {
        continue;
      }
      if (textForms.some((textForm) => sequenceIn(wordsOf(textForm), [word]))) {
        return true;
      }
    }
  }
  return false;
}

/** What the rules find in a text, in a fixed order; empty — nothing. */
export function reviewRuleFindings(text: string, context: ReviewRuleContext): ReviewRuleFinding[] {
  const findings: ReviewRuleFinding[] = [];
  const contacts = warrantyTextContacts(text);
  if (contacts.length > 0) {
    findings.push({ kind: "contacts", contacts });
  }
  const textForms = forms(text);
  if (context.supplierNames.some((name) => companyNameIn(textForms, name))) {
    findings.push({ kind: "supplier_name" });
  }
  if (context.employeeNames.some((name) => personNameIn(textForms, name))) {
    findings.push({ kind: "employee_name" });
  }
  return findings;
}
