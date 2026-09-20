import { describe, expect, it } from "vitest";
import { loadEvalData, loadGlossary } from "./eval-data";
import { checkRun, type QualityCheck } from "./translation-quality";
import type { EvalSample, EvalTerm } from "./eval-data";

// A raw control character, written as an escape so the source stays plain text.
const BELL = String.fromCharCode(7);

const SAMPLES: EvalSample[] = [
  {
    id: "cat-pads",
    text: "Тормозные колодки",
    entityType: "category",
    field: "name",
    scope: "brakes",
  },
  {
    id: "cat-discs",
    text: "Тормозные диски",
    entityType: "category",
    field: "name",
    scope: "brakes",
  },
  {
    id: "item-front",
    text: "Колодки тормозные передние",
    entityType: "catalog_item",
    field: "name",
    scope: "items",
  },
  {
    id: "item-rear",
    text: "Колодки тормозные задние",
    entityType: "catalog_item",
    field: "name",
    scope: "items",
  },
  { id: "attr-axle", text: "Ось", entityType: "attribute", field: "name", scope: "attrs" },
  { id: "unit-litre", text: "л", entityType: "attribute", field: "unit", scope: "units" },
];

const TERMS: EvalTerm[] = [
  {
    ru: "колодки",
    samples: ["cat-pads", "item-front", "item-rear"],
    kkForms: ["қалып"],
    kkRussisms: ["колодк"],
    enForms: ["pad"],
  },
];

/** A run in which every check passes: the yardstick the other cases move away from. */
const GOOD: Record<string, string> = {
  "cat-pads:kk": "Тежегіш қалыптары",
  "cat-pads:en": "Brake pads",
  "cat-discs:kk": "Тежегіш дискілері",
  "cat-discs:en": "Brake discs",
  "item-front:kk": "Алдыңғы тежегіш қалыптары",
  "item-front:en": "Front brake pads",
  "item-rear:kk": "Артқы тежегіш қалыптары",
  "item-rear:en": "Rear brake pads",
  "attr-axle:kk": "Білік",
  "attr-axle:en": "Axle",
  "unit-litre:kk": "л",
  "unit-litre:en": "L",
};

function run(changes: Record<string, string | undefined> = {}) {
  const answers = new Map<string, string>(Object.entries(GOOD));
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) {
      answers.delete(key);
    } else {
      answers.set(key, value);
    }
  }
  return checkRun(SAMPLES, TERMS, answers);
}

function checksOf(report: ReturnType<typeof run>): QualityCheck[] {
  return report.findings.map((finding) => finding.check);
}

describe("machine checks of a translation run (TASK-053.B)", () => {
  it("finds nothing in a run where every text is good", () => {
    const report = run();
    expect(report.findings).toEqual([]);
    expect(report.expected).toBe(12);
    expect(report.answered).toBe(12);
    expect(report.problemTexts).toBe(0);
    expect(report.problemShare).toBe(0);
  });

  it("counts a text the model said nothing about", () => {
    const report = run({ "cat-pads:kk": undefined });
    expect(checksOf(report)).toEqual(["missing"]);
    expect(report.answered).toBe(11);
    expect(report.expected).toBe(12);
    expect(report.findings[0]).toMatchObject({ sampleId: "cat-pads", lang: "kk" });
  });

  it("applies the very checks that decide whether a translation may be saved", () => {
    expect(checksOf(run({ "cat-pads:kk": "   " }))).toEqual(["empty"]);
    expect(checksOf(run({ "cat-pads:kk": "х".repeat(41) }))).toEqual(["too_long"]);
    expect(checksOf(run({ "cat-pads:kk": `Тежегіш${BELL}қалыптары` }))).toEqual([
      "control_characters",
    ]);
    // English that is still Russian, and Kazakh that came back in Latin letters.
    expect(checksOf(run({ "cat-pads:en": "Тормозные колодки" }))).toEqual(["wrong_language"]);
    // A text the checks refuse is not looked at for terms: it would not be saved.
    expect(checksOf(run({ "cat-pads:kk": "Brake pads" }))).toEqual(["wrong_language"]);
  });

  it("finds a Kazakh text that is the Russian one, and leaves units alone", () => {
    const report = run({ "attr-axle:kk": "Ось" });
    expect(checksOf(report)).toEqual(["untranslated"]);
    expect(report.findings[0]).toMatchObject({ sampleId: "attr-axle", lang: "kk" });
    // A unit is an abbreviation: "л" staying "л" is not an untranslated word.
    expect(checksOf(run({ "unit-litre:kk": "л" }))).toEqual([]);
  });

  it("finds a Russian stem left inside a Kazakh name, and the term rendered two ways", () => {
    const report = run({ "item-rear:kk": "Артқы тежегіш колодкалар" });
    expect(checksOf(report)).toEqual(["russism", "inconsistent_term"]);
    expect(report.findings[1]!.detail).toContain("колодк");
    expect(report.findings[1]!.detail).toContain("қалып");
    // A russism on its own, with no other name of that term to disagree with.
    const alone = checkRun(
      SAMPLES,
      [{ ...TERMS[0]!, samples: ["item-rear"] }],
      new Map(Object.entries({ ...GOOD, "item-rear:kk": "Артқы тежегіш колодкалар" })),
    );
    expect(checksOf(alone)).toEqual(["russism"]);
  });

  it("finds English rendered two ways for one Russian term", () => {
    const report = run({ "item-rear:en": "Rear brake blocks" });
    expect(checksOf(report)).toEqual(["term_absent"]);
    const both = run({ "item-rear:en": "Rear brake shoe" });
    // "shoe" is not a known rendering either: a third wording, not a clash.
    expect(checksOf(both)).toEqual(["term_absent"]);
  });

  it("finds a name that came back starting with a small letter, and leaves units alone", () => {
    const report = run({ "cat-pads:kk": "тежегіш қалыптары" });
    expect(checksOf(report)).toEqual(["lowercase_name"]);
    expect(report.findings[0]).toMatchObject({ sampleId: "cat-pads", lang: "kk" });
    // A unit is not a name: "л" and "L" are both right.
    expect(checksOf(run({ "unit-litre:en": "l" }))).toEqual([]);
    // A Russian text that itself starts small asks for nothing.
    expect(
      checkRun(
        [{ id: "x", text: "шт", entityType: "attribute", field: "name", scope: "s" }],
        [],
        new Map([
          ["x:kk", "дана"],
          ["x:en", "pcs"],
        ]),
      ).findings,
    ).toEqual([]);
  });

  it("finds a name that a neighbour already has, and allows it outside the neighbourhood", () => {
    const report = run({ "cat-discs:kk": "Тежегіш қалыптары" });
    expect(checksOf(report)).toEqual(["duplicate"]);
    expect(report.findings[0]).toMatchObject({ sampleId: "cat-discs", lang: "kk" });
    // The same text in another scope is not a clash.
    expect(checksOf(run({ "attr-axle:kk": "Тежегіш қалыптары" }))).toEqual([]);
  });

  it("counts every text with a finding once, however many findings it has", () => {
    const report = run({ "item-rear:kk": "Артқы тежегіш колодкалар" });
    // A russism and an inconsistency, both about the one text that departs.
    expect(report.findings).toHaveLength(2);
    expect(report.findings.every((finding) => finding.sampleId === "item-rear")).toBe(true);
    expect(report.problemTexts).toBe(1);
    expect(report.problemShare).toBe(Math.round((1 / 12) * 1000) / 1000);
  });

  it("observes the Kazakh letters and the case of English names without calling them failures", () => {
    const report = run();
    // Only "Тежегіш дискілері", "Алдыңғы…", "Артқы…", "Тежегіш қалыптары", "Білік" have them; "л" does not.
    expect(report.observations.kazakhLetterShare).toBeGreaterThan(0.8);
    expect(report.observations.kazakhLetterShare).toBeLessThan(1);
    expect(report.observations.enTitleCaseShare).toBe(0);
    expect(
      run({ "item-rear:en": "Rear Brake Pads" }).observations.enTitleCaseShare,
    ).toBeGreaterThan(0);
    expect(run({ "item-rear:en": "Rear Brake Pads" }).findings).toEqual([]);
  });
});

describe("the sample set and the glossary in the repository (TASK-053.B)", () => {
  const data = loadEvalData();

  it("is 40 to 60 texts of the catalog, each with its own id and text", () => {
    expect(data.samples.length).toBeGreaterThanOrEqual(40);
    expect(data.samples.length).toBeLessThanOrEqual(60);
    expect(new Set(data.samples.map((sample) => sample.id)).size).toBe(data.samples.length);
    expect(new Set(data.samples.map((sample) => sample.text)).size).toBe(data.samples.length);
  });

  it("covers every kind of text of the catalog", () => {
    const kinds = new Set(data.samples.map((sample) => `${sample.entityType}:${sample.field}`));
    expect([...kinds].sort()).toEqual([
      "attribute:name",
      "attribute:unit",
      "attribute_option:name",
      "catalog_item:name",
      "category:name",
    ]);
    // Parts with a brand and an article number, and services.
    expect(data.samples.some((sample) => /Geely \d/u.test(sample.text))).toBe(true);
    expect(data.samples.some((sample) => sample.text.startsWith("Замена"))).toBe(true);
  });

  it("holds the hard cases the acceptance of TASK-053.A named", () => {
    const texts = new Set(data.samples.map((sample) => sample.text));
    for (const text of [
      "Допуск",
      "Ось",
      "Шиномонтаж",
      "Свечи зажигания",
      "Стойки стабилизатора",
      "Прокладки и сальники",
      "Расходники",
      "Синтетика",
      "Минеральное",
    ]) {
      expect(texts.has(text), text).toBe(true);
    }
    // The same term in several names: front and rear pads, and the services of both.
    const pads = data.samples.filter((sample) => /колод/iu.test(sample.text));
    expect(pads.length).toBeGreaterThanOrEqual(6);
  });

  it("has a term dictionary whose samples are all in the set", () => {
    const ids = new Set(data.samples.map((sample) => sample.id));
    expect(data.terms.length).toBeGreaterThanOrEqual(5);
    for (const term of data.terms) {
      for (const id of term.samples) {
        expect(ids.has(id), `${term.ru} → ${id}`).toBe(true);
      }
    }
  });

  it("has a glossary of 10 to 15 terms, each with both languages", () => {
    const glossary = loadGlossary();
    expect(glossary.length).toBeGreaterThanOrEqual(10);
    expect(glossary.length).toBeLessThanOrEqual(15);
    for (const entry of glossary) {
      expect(entry.kk, entry.ru).toBeTruthy();
      expect(entry.en, entry.ru).toBeTruthy();
    }
  });
});
