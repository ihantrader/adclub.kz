import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  dashboardOutputSchema,
  partPhotoOutputSchema,
  readSampleMarker,
  TEST_DASHBOARDS,
  TEST_PART_PHOTOS,
  type DashboardOutput,
  type PartPhotoOutput,
} from "../ai";
import { dashboardAnswer } from "../garage";
import { digitReading, isEanBarcode, partArticles } from "../showcase";
import { prepareDocumentImage } from "../vehicle-document";
import { loadDashboardEvalData, loadPartEvalData, photoEvalDirectory } from "./photo-eval-data";
import { scoreDashboards, scoreParts } from "./photo-eval-score";

/**
 * The synthetic sets of TASK-058 (`ai-eval/dashboard/`, `ai-eval/part-photo/`)
 * and the test AI provider read them the same way: every sample's control
 * strip survives the server's own preparation of the photo, and what the
 * test provider answers for a code is what the set expects of that sample —
 * so the scoring of the comparison gives the test provider full marks.
 */
describe("the dashboard set and the test provider", () => {
  const data = loadDashboardEvalData();

  it("has what the task names: miles, a trip meter, glare, tilt, low resolution, covered, not a dashboard", () => {
    expect(data.samples.length).toBeGreaterThanOrEqual(20);
    const variants = new Set(data.samples.map((sample) => sample.variant));
    for (const variant of [
      "clean",
      "glare",
      "tilt",
      "lowres",
      "occluded",
      "occluded_digits",
      "blur",
    ]) {
      expect(variants).toContain(variant);
    }
    expect(data.samples.some((sample) => sample.expected.unit === "mi")).toBe(true);
    expect(data.samples.some((sample) => sample.expected.tripMeterSeen)).toBe(true);
    expect(
      data.samples.filter((sample) => sample.expected.kind === "not_dashboard").length,
    ).toBeGreaterThanOrEqual(3);
    expect(data.samples.some((sample) => sample.style === "ignition_off")).toBe(true);
  });

  it.each(data.samples.map((sample) => [sample.id, sample] as const))(
    "%s: the strip survives and the test provider answers as expected",
    async (_id, sample) => {
      const bytes = readFileSync(join(photoEvalDirectory("dashboard"), sample.file));
      const prepared = await prepareDocumentImage(bytes);
      expect(await readSampleMarker(prepared.bytes)).toBe(sample.code);
      const output = dashboardOutputSchema.parse(TEST_DASHBOARDS[sample.code]);
      expect(output).not.toHaveProperty("extra");
      const answer = dashboardAnswer(output);
      if (sample.readable) {
        expect(answer.kind).toBe("dashboard");
        expect(answer.mileageKm).toBe(sample.expected.mileageKm);
        expect(answer.unit).toBe(sample.expected.unit);
        expect(answer.tripMeterSeen).toBe(sample.expected.tripMeterSeen);
      } else if (sample.expected.kind === "not_dashboard") {
        expect(answer.kind).toBe("not_dashboard");
      } else {
        expect(sample.acceptKinds ?? ["unreadable"]).toContain(answer.kind);
      }
    },
  );

  it("scores the test provider at full marks", () => {
    const answers = new Map<string, DashboardOutput>(
      data.samples.map((sample) => [sample.id, TEST_DASHBOARDS[sample.code]!]),
    );
    const score = scoreDashboards(data.samples, answers);
    expect(score.value.share).toBe(1);
    expect(score.refusal.share).toBe(1);
    expect(score.passes).toBe(true);
    // The covered digits are answered as a guessing model would: counted apart, not as false.
    expect(score.guessedHidden).toBe(1);
    expect(score.falseValues.correct).toBe(0);
  });
});

describe("the part set and the test provider", () => {
  const data = loadPartEvalData();

  it("has what the task names: dashes or none, O and 0, barcode and date, two articles, no article", () => {
    expect(data.samples.length).toBeGreaterThanOrEqual(20);
    const all = data.samples.flatMap((sample) => sample.expected.articles);
    expect(all).toContain("044650K090");
    expect(all).toContain("GDB3534");
    expect(data.samples.some((sample) => sample.expected.articles.length === 2)).toBe(true);
    expect(data.samples.some((sample) => sample.expected.notArticles.length >= 3)).toBe(true);
    expect(
      data.samples.filter((sample) => sample.expected.kind === "no_article").length,
    ).toBeGreaterThanOrEqual(3);
  });

  it.each(data.samples.map((sample) => [sample.id, sample] as const))(
    "%s: the strip survives and the test provider answers as expected",
    async (_id, sample) => {
      const bytes = readFileSync(join(photoEvalDirectory("part-photo"), sample.file));
      const prepared = await prepareDocumentImage(bytes);
      expect(await readSampleMarker(prepared.bytes)).toBe(sample.code);
      const output = partPhotoOutputSchema.parse(TEST_PART_PHOTOS[sample.code]);
      expect(output).not.toHaveProperty("extra");
      const read = partArticles(output).map((article) => article.normalized);
      if (sample.readable) expect(read).toEqual(sample.expected.articles);
      if (sample.expected.kind === "no_article") expect(read).toEqual([]);
    },
  );

  it("scores the test provider at full marks", () => {
    const answers = new Map<string, PartPhotoOutput>(
      data.samples.map((sample) => [sample.id, TEST_PART_PHOTOS[sample.code]!]),
    );
    const score = scoreParts(data.samples, answers);
    expect(score.article.share).toBe(1);
    expect(score.falseArticle.correct).toBe(0);
    expect(score.secondArticle.share).toBe(1);
    expect(score.noArticle.share).toBe(1);
    expect(score.passes).toBe(true);
  });
});

describe("dashboardAnswer", () => {
  const base: DashboardOutput = {
    kind: "dashboard",
    totalMileage: 45_200,
    unit: "km",
    confidence: 0.9,
    tripMeterSeen: false,
  };

  it("passes kilometres on and converts miles", () => {
    expect(dashboardAnswer(base)).toMatchObject({
      kind: "dashboard",
      mileageKm: 45_200,
      unit: "km",
    });
    expect(dashboardAnswer({ ...base, totalMileage: 28_087, unit: "mi" })).toMatchObject({
      mileageKm: 45_202,
      unit: "mi",
    });
  });

  it("makes a reading without a number or out of range unreadable", () => {
    expect(dashboardAnswer({ ...base, totalMileage: null }).kind).toBe("unreadable");
    expect(dashboardAnswer({ ...base, totalMileage: 3_000_000 }).kind).toBe("unreadable");
    expect(dashboardAnswer({ ...base, totalMileage: -1 }).kind).toBe("unreadable");
  });

  it("keeps the confidence within 0…1 and drops the reading of what is not a dashboard", () => {
    expect(dashboardAnswer({ ...base, confidence: 7 }).confidence).toBe(1);
    expect(dashboardAnswer({ ...base, kind: "not_dashboard" })).toMatchObject({
      kind: "not_dashboard",
      mileageKm: null,
      unit: null,
    });
  });
});

describe("the articles of a part", () => {
  it("drops a barcode, a text without a digit and a repeat; likeliest first", () => {
    const read = partArticles({
      kind: "article_found",
      articles: [
        { text: "4027816350743", confidence: 0.99 },
        { text: "FEB 35074", confidence: 0.6 },
        { text: "FEB-35074", confidence: 0.7 },
        { text: "FEBI", confidence: 0.9 },
        { text: "04465-0K090", confidence: 0.8 },
      ],
      brand: "FEBI",
      labelText: null,
    });
    expect(read.map((article) => article.normalized)).toEqual(["044650K090", "FEB35074"]);
    expect(read[1]!.text).toBe("FEB-35074");
  });

  it("knows an EAN by its check digit", () => {
    expect(isEanBarcode("4027816350743")).toBe(true);
    expect(isEanBarcode("4027816350741")).toBe(false);
    expect(isEanBarcode("4050068800")).toBe(false);
    // Eight digits are an article (GM 96473723), never a barcode — even when
    // the last digit happens to satisfy the EAN-8 check, as in 96385074.
    expect(isEanBarcode("96385074")).toBe(false);
    expect(isEanBarcode("96473723")).toBe(false);
  });

  it("reads O as 0 and I as 1 when asked", () => {
    expect(digitReading("O4465OK09O")).toBe("04465" + "0K090");
    expect(digitReading("044650K090")).toBeNull();
  });

  it("gives nothing for an answer without an article", () => {
    expect(
      partArticles({ kind: "no_article", articles: [], brand: null, labelText: null }),
    ).toEqual([]);
  });
});
