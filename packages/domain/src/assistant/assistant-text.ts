import { warrantyTextContacts } from "../offer/warranty-text";

/**
 * What of a model's text may reach the screen (TASK-062; ARCHITECTURE 11.1,
 * PRODUCT 8.3): the text of the assistant is only text. Nothing in it is
 * rendered as a product (cards are built by the server from the catalog),
 * and nothing in it may lead out of the club: a sentence with a phone
 * number, a link, a messenger handle or an e-mail is dropped whole — the
 * same detector that keeps contacts out of a warranty (`warrantyTextContacts`,
 * TASK-020.A) — and HTML, markdown links and markdown marks are taken off.
 */

export interface CleanedAssistantText {
  /** What may be shown; empty — nothing of the model's text is left. */
  text: string;
  /** How many sentences were dropped for a contact or a link. */
  droppedSentences: number;
  /** Markup (HTML, markdown links or marks) was taken off. */
  markupRemoved: boolean;
}

/** The longest text of an answer kept (an answer is a few sentences, never a page). */
export const ASSISTANT_TEXT_MAX_LENGTH = 1500;

/** Control characters but the line break, and the invisible ones (the joiner of emoji stays). */
const CONTROL =
  /(?!\n)[\p{Cc}\u{200b}\u{200c}\u{200e}\u{200f}\u{2028}-\u{202e}\u{2060}-\u{2064}\u{feff}]/gu;
const HTML_TAG = /<\/?[a-z][^<>]{0,300}>/giu;
const MARKDOWN_IMAGE = /!\[[^\]]{0,300}\]\([^)]{0,500}\)/gu;
const MARKDOWN_LINK = /\[([^\]]{0,300})\]\([^)]{0,500}\)/gu;
const MARKDOWN_MARKS = /(\*\*|__|~~|`+)/gu;
const HEADING = /^\s{0,3}#{1,6}\s+/gmu;
const QUOTE = /^\s{0,3}>\s?/gmu;
const BULLET = /^\s{0,3}[-*+]\s+/gmu;
/** A single `*` or `_` around a word (emphasis), not inside words. */
const EMPHASIS = /(^|[\s(])[*_]([^*_\n]{1,200})[*_](?=$|[\s.,!?;:)])/gmu;

/** The longest message a person sends the assistant (the contract checks it before this). */
export const ASSISTANT_MESSAGE_MAX_LENGTH = 1000;

/**
 * A person's message as the assistant takes it: control and invisible
 * characters dropped, every run of spaces and line breaks one space, at most
 * `ASSISTANT_MESSAGE_MAX_LENGTH` characters. Emoji stay — they are words to
 * a person. Empty — nothing was said (the route answers 400).
 */
export function normalizeAssistantMessage(text: string): string {
  const flat = text
    .normalize("NFC")
    .replace(/[\r\n\t\u2028\u2029]+/gu, " ")
    .replace(CONTROL, "")
    .replace(/\s+/gu, " ")
    .trim();
  return [...flat].slice(0, ASSISTANT_MESSAGE_MAX_LENGTH).join("").trimEnd();
}

/** Sentences of a line: after `.`, `!`, `?` or `…` and a space. */
function sentencesOf(line: string): string[] {
  return line.split(/(?<=[.!?…])\s+/u);
}

export function cleanAssistantText(
  raw: string,
  maxLength: number = ASSISTANT_TEXT_MAX_LENGTH,
): CleanedAssistantText {
  let text = raw.normalize("NFC").replace(/\r\n?/gu, "\n").replace(CONTROL, "");
  const before = text;
  text = text
    .replace(MARKDOWN_IMAGE, "")
    .replace(MARKDOWN_LINK, "$1")
    .replace(HTML_TAG, "")
    .replace(HEADING, "")
    .replace(QUOTE, "")
    .replace(BULLET, "• ")
    .replace(EMPHASIS, "$1$2")
    .replace(MARKDOWN_MARKS, "");
  const markupRemoved = text !== before;
  let droppedSentences = 0;
  const lines = text.split("\n").map((line) => {
    const kept = sentencesOf(line).filter((sentence) => {
      if (warrantyTextContacts(sentence).length > 0) {
        droppedSentences += 1;
        return false;
      }
      return true;
    });
    return kept
      .join(" ")
      .replace(/[ \t]{2,}/gu, " ")
      .trim();
  });
  const joined = lines
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  const cut = joined.length <= maxLength ? joined : `${joined.slice(0, maxLength - 1).trimEnd()}…`;
  return { text: cut, droppedSentences, markupRemoved };
}

/**
 * Phrases by which a model would claim to know what is wrong with a car
 * (ARCHITECTURE 11.1 point 5): the assistant does not diagnose, and a text
 * with any of them is replaced by a neutral line. Data, by language; each
 * phrase matches at the beginning of a word, in any case. «Диагностика»
 * (a service of the catalog) is not «диагноз».
 */
export const ASSISTANT_DIAGNOSIS_PHRASES = {
  ru: [
    "диагноз",
    "точно неисправ",
    "точно сломан",
    "однозначно неисправ",
    "у вас неисправ",
    "у вас сломан",
    "причина точно",
    "причина однозначно",
    "100% причина",
    "100 % причина",
    "наверняка неисправ",
  ],
  kk: ["диагноз", "нақты ақау", "сөзсіз ақау", "міндетті түрде ақау", "ақау анық"],
  en: [
    "diagnosis",
    "diagnosed",
    "i diagnose",
    "definitely faulty",
    "definitely broken",
    "is definitely the cause",
    "the cause is definitely",
    "100% the cause",
    "your car has a faulty",
  ],
} as const;

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

const DIAGNOSIS = new RegExp(
  `(?:^|[^\\p{L}\\p{N}])(?:${[...new Set(Object.values(ASSISTANT_DIAGNOSIS_PHRASES).flat())]
    .map(escape)
    .join("|")})`,
  "iu",
);

/** The text claims a diagnosis (one of `ASSISTANT_DIAGNOSIS_PHRASES`). */
export function claimsDiagnosis(text: string): boolean {
  return DIAGNOSIS.test(text.normalize("NFC"));
}
