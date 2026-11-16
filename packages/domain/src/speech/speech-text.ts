/**
 * What a recognised recording becomes in the search line (TASK-059; SCREENS
 * M-CAT-05; ARCHITECTURE 4.90): the model's words only, as a person would
 * type them — no service marks, no quotes, no closing full stop, no more
 * than the search line takes (`SEARCH_QUERY_MAX_LENGTH`, cut by a word).
 * Nothing left — «Не расслышали, попробуйте ещё раз».
 */

/** The search line takes this much (`SEARCH_QUERY_MAX_LENGTH` of the contract). */
export const SPEECH_TEXT_MAX_LENGTH = 100;

export interface CleanedSpeechText {
  /** The text for the search line; empty — nothing was heard. */
  text: string;
  heard: boolean;
  /** The text was longer than the line and was cut by a word. */
  cut: boolean;
}

// Control characters, but not the ordinary space.
const CONTROL_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x08],
  [0x0b, 0x1f],
  [0x7f, 0x9f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0xfeff, 0xfeff],
];
const CONTROL = new RegExp(
  `[${CONTROL_RANGES.map(([from, to]) => `${String.fromCodePoint(from)}-${String.fromCodePoint(to)}`).join("")}]`,
  "gu",
);

/**
 * What a model writes instead of words: [неразборчиво], <noise>, (music),
 * *кашель*. Square, angle and curly brackets are never typed into a search,
 * so whatever they hold goes; round ones only around these words.
 */
const SERVICE_WORDS =
  "шум|тишина|неразборчиво|неразборчивая речь|музыка|смех|кашель|пауза|звук|нет речи|речь отсутствует|" +
  "noise|silence|inaudible|unintelligible|music|laughter|laughs|cough|pause|no speech|background noise|" +
  "шу|тыныштық|түсініксіз";
const ROUND_SERVICE = new RegExp(`\\(\\s*(?:${SERVICE_WORDS})\\s*\\)`, "giu");
const STAR_SERVICE = new RegExp(`\\*\\s*(?:${SERVICE_WORDS})\\s*\\*`, "giu");
const BRACKETED = /\[[^\]]*\]|<[^>]*>|\{[^}]*\}/gu;
/** «Транскрипция:», «Text:» before the words. */
const LABEL =
  /^\s*(?:transcription|transcript|text|текст|расшифровка|транскрипция|мәтін)\s*[:：-]\s*/iu;
const QUOTES = /^[\s"'«»“”„‘’`]+|[\s"'«»“”„‘’`]+$/gu;
const CLOSING = /[\s.!?…。]+$/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** The answer of the model as the search line takes it. */
export function cleanSpeechText(
  raw: string,
  maxLength: number = SPEECH_TEXT_MAX_LENGTH,
): CleanedSpeechText {
  let text = raw
    .normalize("NFC")
    .replace(/\s+/gu, " ")
    .replace(CONTROL, "")
    .replace(BRACKETED, " ")
    .replace(ROUND_SERVICE, " ")
    .replace(STAR_SERVICE, " ")
    .replace(LABEL, "")
    .replace(QUOTES, "")
    .replace(CLOSING, "")
    .replace(/ {2,}/gu, " ")
    .trim();
  if (!LETTER_OR_DIGIT.test(text)) {
    return { text: "", heard: false, cut: false };
  }
  let cut = false;
  if (text.length > maxLength) {
    cut = true;
    const head = text.slice(0, maxLength + 1);
    const space = head.lastIndexOf(" ");
    text = (space > 0 ? head.slice(0, space) : text.slice(0, maxLength)).replace(
      /[\s,;:–—-]+$/u,
      "",
    );
  }
  return { text, heard: true, cut };
}

/**
 * Whether a recognition costs the person an attempt of their limit
 * (ARCHITECTURE 4.90): the size, the length and the format are refused
 * before anything is counted; a provider that could not serve the request
 * (down, refusing, the day's budget spent) gives the attempt back; a
 * recording that reached the model costs one — silence included: the app
 * does not send a recording in which it heard nothing at all
 * (`speechHeardAnything`), so what reaches the server was the person's
 * choice.
 */
export type SpeechAttemptOutcome =
  "too_large" | "invalid" | "provider_unavailable" | "budget_spent" | "transcribed";

export function speechAttemptCharge(
  outcome: SpeechAttemptOutcome,
): "not_counted" | "given_back" | "spent" {
  switch (outcome) {
    case "too_large":
    case "invalid":
      return "not_counted";
    case "provider_unavailable":
    case "budget_spent":
      return "given_back";
    case "transcribed":
      return "spent";
  }
}
