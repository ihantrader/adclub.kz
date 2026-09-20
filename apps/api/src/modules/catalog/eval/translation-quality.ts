import type { TranslationTargetLanguage } from "@adclub/contracts";
import { normalizeText } from "../catalog-texts";
import { checkTranslation, maxLengthOf } from "../translation-checks";
import type { EvalSample, EvalTerm } from "./eval-data";

/**
 * The machine checks of a translation run (TASK-053.B requirement 2).
 * They do not judge meaning — that is for a person who knows the
 * language; they answer what can be counted, so models can be compared
 * on the same set by the same numbers:
 *
 * - `missing` — the model said nothing about this text and language;
 * - `empty`, `too_long`, `control_characters`, `wrong_language` — the
 *   very checks the running translation applies before saving
 *   (`checkTranslation`), so a model's score here is the share of texts
 *   the catalog would refuse;
 * - `untranslated` — the Kazakh text is the Russian one, letter for
 *   letter (what "Ось" → "Ось" and "Шиномонтаж" → "Шиномонтаж" were);
 * - `russism` — a Russian stem from the dictionary is left inside the
 *   Kazakh text ("колодкалар", "сальниктер");
 * - `inconsistent_term` — one Russian term is rendered two ways across
 *   the names of the set ("қалыптары" in one name, "колодкалар" in the
 *   next);
 * - `term_absent` — a name of the term's list does not contain any known
 *   rendering of it: possibly a third wording, possibly a good synonym —
 *   a weaker signal, counted apart from the inconsistency;
 * - `duplicate` — two neighbours (one `scope`) got the same name, which
 *   the catalog refuses as taken;
 * - `lowercase_name` — a name whose Russian begins with a capital letter
 *   came back beginning with a small one, which a catalog shows as it is.
 */

export const qualityChecks = [
  "missing",
  "empty",
  "too_long",
  "control_characters",
  "wrong_language",
  "untranslated",
  "russism",
  "inconsistent_term",
  "term_absent",
  "duplicate",
  "lowercase_name",
] as const;

export type QualityCheck = (typeof qualityChecks)[number];

export interface QualityFinding {
  check: QualityCheck;
  lang: TranslationTargetLanguage;
  /** The sample the finding is about; an inconsistency of a term names the first of them. */
  sampleId: string;
  /** The Russian text, for reading the report. */
  source: string;
  /** What was found, in words: the text, the stem, the variants. */
  detail: string;
}

export interface QualityObservations {
  /** Of the Kazakh texts, the share containing a letter Russian does not have (ә, қ, ң, ө, ұ, ү, һ, і). */
  kazakhLetterShare: number;
  /** Of the English names of two words or more, the share written in Title Case. */
  enTitleCaseShare: number;
}

export interface QualityReport {
  /** Texts asked for: every sample in every language of the run. */
  expected: number;
  /** Texts the model answered with. */
  answered: number;
  counts: Record<QualityCheck, number>;
  /** Texts with at least one finding, and their share of `expected`. */
  problemTexts: number;
  problemShare: number;
  findings: QualityFinding[];
  observations: QualityObservations;
}

/** A translation of one sample into one language, as the model gave it. */
export type Answers = ReadonlyMap<string, string>;

export function answerKey(sampleId: string, lang: TranslationTargetLanguage): string {
  return `${sampleId}:${lang}`;
}

/** Letters Kazakh has and Russian does not. */
const KAZAKH_LETTERS = /[әғқңөұүһі]/iu;
/** A word in Cyrillic letters, as opposed to a stray letter like the unit "л". */
const RUSSIAN_WORD = /\p{Script=Cyrillic}{2,}/u;

function contains(text: string, stem: string): boolean {
  return text.toLowerCase().includes(stem.toLowerCase());
}

/** The longest stem of `stems` inside `text`; `undefined` — none of them. */
function matched(text: string, stems: readonly string[]): string | undefined {
  return [...stems]
    .sort((left, right) => right.length - left.length)
    .find((stem) => contains(text, stem));
}

/**
 * Runs every check over one model's answers. `languages` is what the run
 * asked for; a sample the run did not ask about in a language is not
 * counted as missing.
 */
export function checkRun(
  samples: readonly EvalSample[],
  terms: readonly EvalTerm[],
  answers: Answers,
  languages: readonly TranslationTargetLanguage[] = ["kk", "en"],
): QualityReport {
  const findings: QualityFinding[] = [];
  const counts = Object.fromEntries(qualityChecks.map((check) => [check, 0])) as Record<
    QualityCheck,
    number
  >;
  const problems = new Set<string>();
  const add = (finding: QualityFinding): void => {
    findings.push(finding);
    counts[finding.check] += 1;
    problems.add(answerKey(finding.sampleId, finding.lang));
  };

  let expected = 0;
  let answered = 0;
  const usable = new Map<string, string>();
  const kazakhTexts: string[] = [];
  const englishNames: string[] = [];

  for (const sample of samples) {
    const max = maxLengthOf(sample.entityType, sample.field);
    for (const lang of languages) {
      expected += 1;
      const raw = answers.get(answerKey(sample.id, lang));
      if (raw === undefined) {
        add({
          check: "missing",
          lang,
          sampleId: sample.id,
          source: sample.text,
          detail: "the model said nothing about this text",
        });
        continue;
      }
      answered += 1;
      // The same checks that decide whether a translation may be saved.
      const checked = checkTranslation(raw, lang, sample.text, max);
      if (!checked.ok) {
        add({
          check: checked.failure,
          lang,
          sampleId: sample.id,
          source: sample.text,
          detail: `${JSON.stringify(raw)} (limit ${max})`,
        });
        continue;
      }
      const text = checked.text;
      usable.set(answerKey(sample.id, lang), text);
      // A name is shown as it is written: a capital in Russian is a capital
      // in the translation. A unit is not a name ("л", "mm").
      if (sample.field !== "unit" && /^\p{Lu}/u.test(sample.text) && /^\p{Ll}/u.test(text)) {
        add({
          check: "lowercase_name",
          lang,
          sampleId: sample.id,
          source: sample.text,
          detail: `starts with a small letter: ${JSON.stringify(text)}`,
        });
      }
      if (lang === "kk") {
        kazakhTexts.push(text);
        // Only a text with a Russian word in it can be left untranslated.
        // A unit is an abbreviation ("л" is "л" in both languages), and a
        // name that is a brand, a grade and a unit ("Shell Helix HX8
        // 5W-30, 4 л") is right to come back as it is — one stray Cyrillic
        // letter is not a word.
        if (
          sample.field !== "unit" &&
          RUSSIAN_WORD.test(sample.text) &&
          text.toLowerCase() === normalizeText(sample.text).toLowerCase()
        ) {
          add({
            check: "untranslated",
            lang,
            sampleId: sample.id,
            source: sample.text,
            detail: `left as the Russian text: ${JSON.stringify(text)}`,
          });
        }
      } else if (text.split(" ").length > 1) {
        englishNames.push(text);
      }
    }
  }

  // Terms: the same Russian word rendered the same way everywhere, and no
  // Russian stem left inside a Kazakh name.
  for (const term of terms) {
    for (const lang of languages) {
      const forms = lang === "kk" ? term.kkForms : term.enForms;
      const russisms = lang === "kk" ? term.kkRussisms : [];
      if (forms.length === 0 && russisms.length === 0) {
        continue;
      }
      const variants = new Map<string, string[]>();
      for (const id of term.samples) {
        const text = usable.get(answerKey(id, lang));
        if (text === undefined) {
          continue;
        }
        const russism = matched(text, russisms);
        if (russism !== undefined) {
          add({
            check: "russism",
            lang,
            sampleId: id,
            source: term.ru,
            detail: `"${term.ru}" stayed Russian inside ${JSON.stringify(text)} ("${russism}")`,
          });
        }
        const form = russism ?? matched(text, forms);
        if (form === undefined) {
          add({
            check: "term_absent",
            lang,
            sampleId: id,
            source: term.ru,
            detail: `${JSON.stringify(text)} has no known rendering of "${term.ru}"`,
          });
          continue;
        }
        variants.set(form, [...(variants.get(form) ?? []), id]);
      }
      if (variants.size > 1) {
        // The wording most of the names use is taken as the prevailing one
        // (a tie goes to the one that appeared first, so the result does not
        // depend on the order the checks happen to run in), and every name
        // that departs from it is the finding: the texts that disagree are
        // what a person has to look at, not the ones that agree.
        const groups = [...variants];
        const prevailing = groups.reduce((best, group) =>
          group[1].length > best[1].length ? group : best,
        );
        const summary = groups.map(([form, ids]) => `"${form}" (${ids.join(", ")})`).join(" vs ");
        for (const [form, ids] of groups) {
          if (form === prevailing[0]) {
            continue;
          }
          for (const id of ids) {
            add({
              check: "inconsistent_term",
              lang,
              sampleId: id,
              source: term.ru,
              detail: `"${term.ru}" is rendered ${variants.size} ways across the set: ${summary}`,
            });
          }
        }
      }
    }
  }

  // Neighbours with the same name: what the catalog refuses as taken.
  const byScope = new Map<string, string>();
  for (const sample of samples) {
    for (const lang of languages) {
      const text = usable.get(answerKey(sample.id, lang));
      if (text === undefined) {
        continue;
      }
      const key = `${sample.scope}:${lang}:${text.toLowerCase()}`;
      const earlier = byScope.get(key);
      if (earlier === undefined) {
        byScope.set(key, sample.id);
        continue;
      }
      add({
        check: "duplicate",
        lang,
        sampleId: sample.id,
        source: sample.text,
        detail: `the same name as ${earlier} among its neighbours: ${JSON.stringify(text)}`,
      });
    }
  }

  const share = (part: number, whole: number): number =>
    whole === 0 ? 0 : Math.round((part / whole) * 1000) / 1000;

  return {
    expected,
    answered,
    counts,
    problemTexts: problems.size,
    problemShare: share(problems.size, expected),
    findings,
    observations: {
      kazakhLetterShare: share(
        kazakhTexts.filter((text) => KAZAKH_LETTERS.test(text)).length,
        kazakhTexts.length,
      ),
      enTitleCaseShare: share(
        englishNames.filter((text) =>
          text
            .split(" ")
            .slice(1)
            .some((word) => /^\p{Lu}/u.test(word)),
        ).length,
        englishNames.length,
      ),
    },
  };
}
