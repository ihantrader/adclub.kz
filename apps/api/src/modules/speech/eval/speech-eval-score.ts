import { normalizeArticle } from "@adclub/domain";

/**
 * How a model's transcription is scored against what a person would type
 * (TASK-059, D-058): the word error rate (WER) against the closest of the
 * acceptable spellings, whether an article came out exactly, whether
 * silence and noise came out empty. The thresholds: an article exactly in
 * ≥ 90 % of the article samples, the Russian WER ≤ 15 %.
 */

export const SPEECH_ARTICLE_THRESHOLD = 0.9;
export const SPEECH_RU_WER_THRESHOLD = 0.15;

export interface SpeechScoreSample {
  id: string;
  lang: string | null;
  expected: readonly string[];
  article: string | null;
}

/** Letters that look the same in Cyrillic and Latin, as a model may write a code. */
const LOOKALIKE: Readonly<Record<string, string>> = {
  А: "A",
  В: "B",
  Е: "E",
  К: "K",
  М: "M",
  Н: "H",
  О: "O",
  Р: "P",
  С: "C",
  Т: "T",
  Х: "X",
  У: "Y",
};

/**
 * The words of a text as they are compared: lower case, `ё → е`, signs
 * gone, a hyphen inside a code joined («5w-30» → «5w30»), a slash a space,
 * digits grouped by thousands joined («45 200» → «45200»).
 */
export function speechWords(text: string): string[] {
  const plain = text
    .toLowerCase()
    .replace(/ё/gu, "е")
    .replace(/(?<=[\p{L}\p{N}])[-‐–](?=[\p{L}\p{N}])/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/(?<=\b\d{1,3}) (?=\d{3}\b)/gu, "")
    .trim();
  return plain === "" ? [] : plain.split(" ");
}

function editDistance(left: readonly string[], right: readonly string[]): number {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const current = row[j]!;
      row[j] = Math.min(
        row[j]! + 1,
        row[j - 1]! + 1,
        previous + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      previous = current;
    }
  }
  return row[right.length]!;
}

/**
 * The errors and the reference words against the closest acceptable
 * spelling. An empty reference (silence): no words is right, any word one
 * error.
 */
export function wordErrorRate(
  hypothesis: string,
  expected: readonly string[],
): { errors: number; words: number; rate: number } {
  const said = speechWords(hypothesis);
  let best: { errors: number; words: number; rate: number } | null = null;
  for (const reference of expected) {
    const words = speechWords(reference);
    const errors = words.length === 0 ? (said.length === 0 ? 0 : 1) : editDistance(words, said);
    const rate = errors / Math.max(1, words.length);
    if (best === null || rate < best.rate)
      best = { errors, words: Math.max(1, words.length), rate };
  }
  return best ?? { errors: 0, words: 1, rate: 0 };
}

/** Whether the article came out exactly: as the search reads an article, lookalike letters taken as Latin. */
export function articleHeard(hypothesis: string, article: string): boolean {
  const latin = hypothesis
    .toUpperCase()
    .replace(/[АВЕКМНОРСТХУ]/gu, (letter) => LOOKALIKE[letter] ?? letter);
  return normalizeArticle(latin).includes(normalizeArticle(article));
}

export interface SpeechScore {
  samples: number;
  answered: number;
  /** Word errors over reference words, by language (`none` — silence and noise). */
  werByLang: Record<string, { errors: number; words: number; rate: number }>;
  articles: { exact: number; total: number; share: number };
  silence: { empty: number; total: number };
  /** The thresholds of D-058 that a synthetic set can show: articles and Russian. */
  passes: boolean;
  misses: { id: string; heard: string; wer: number; article?: boolean }[];
}

export function scoreSpeech(
  samples: readonly SpeechScoreSample[],
  answers: ReadonlyMap<string, string>,
): SpeechScore {
  const werByLang: SpeechScore["werByLang"] = {};
  const misses: SpeechScore["misses"] = [];
  let articleExact = 0;
  let articleTotal = 0;
  let silenceEmpty = 0;
  let silenceTotal = 0;
  for (const sample of samples) {
    const heard = answers.get(sample.id);
    const text = heard ?? "";
    const wer = wordErrorRate(text, sample.expected);
    const lang = sample.lang ?? "none";
    const bucket = (werByLang[lang] ??= { errors: 0, words: 0, rate: 0 });
    // A sample the model did not answer counts as all of its words wrong.
    bucket.errors += heard === undefined ? wer.words : wer.errors;
    bucket.words += wer.words;
    let article: boolean | undefined;
    if (sample.article) {
      articleTotal += 1;
      article = heard !== undefined && articleHeard(text, sample.article);
      if (article) articleExact += 1;
    }
    if (sample.expected.every((reference) => reference === "")) {
      silenceTotal += 1;
      if (heard !== undefined && speechWords(text).length === 0) silenceEmpty += 1;
    }
    if (heard === undefined || wer.errors > 0 || article === false) {
      misses.push({
        id: sample.id,
        heard: heard ?? "(no answer)",
        wer: Math.round(wer.rate * 1000) / 1000,
        ...(article === undefined ? {} : { article }),
      });
    }
  }
  for (const bucket of Object.values(werByLang)) {
    bucket.rate = bucket.words === 0 ? 0 : Math.round((bucket.errors / bucket.words) * 1000) / 1000;
  }
  const share = articleTotal === 0 ? 1 : articleExact / articleTotal;
  const ru = werByLang.ru?.rate ?? 0;
  return {
    samples: samples.length,
    answered: answers.size,
    werByLang,
    articles: { exact: articleExact, total: articleTotal, share: Math.round(share * 1000) / 1000 },
    silence: { empty: silenceEmpty, total: silenceTotal },
    passes: share >= SPEECH_ARTICLE_THRESHOLD && ru <= SPEECH_RU_WER_THRESHOLD,
    misses,
  };
}
