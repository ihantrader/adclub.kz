import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PRICE_PHOTO_MAX_SIDE_PX } from "@adclub/contracts";
import { normalizeArticle, PRICE_PHOTO_ROLES, pricePhotoPage, readPriceRow } from "@adclub/domain";
import { describe, expect, it } from "vitest";
import {
  pricePhotoOutputSchema,
  readSampleMarker,
  TEST_PRICE_PHOTOS,
  type PricePhotoOutput,
} from "../ai";
import { prepareDocumentImage } from "../vehicle-document";
import { loadPricePhotoEvalData, photoEvalDirectory } from "./photo-eval-data";
import { scorePricePhotos } from "./price-photo-score";

const LIMITS = { priceMin: 1, priceMax: 10_000_000, leadDaysMax: 90 };

/**
 * The photographed price pages of TASK-064 (`ai-eval/price-photo/`) and the
 * test AI provider read them the same way: every page's strip survives the
 * server's preparation of a page, and the rows the test provider answers
 * for a code are the rows the set expects — read by `readPriceRow` as the
 * import reads them.
 */
describe("the price photo set and the test provider", () => {
  const data = loadPricePhotoEvalData();

  it("has what the task names: a clean page, two pages, tilt, small print, a screen with glare, no table, unreadable", () => {
    const variants = new Set(data.samples.map((sample) => sample.variant));
    for (const variant of ["clean", "tilt", "glare", "blur"]) expect(variants).toContain(variant);
    expect(data.samples.filter((sample) => sample.pages === 2)).toHaveLength(2);
    expect(data.samples.some((sample) => sample.id.includes("small"))).toBe(true);
    expect(data.samples.some((sample) => sample.expected.kind === "not_a_table")).toBe(true);
    expect(data.samples.some((sample) => sample.expected.kind === "unreadable")).toBe(true);
    expect(
      data.samples.some((sample) => sample.expected.rows.some((row) => row.uncertainPrice)),
    ).toBe(true);
  });

  it.each(data.samples.map((sample) => [sample.id, sample] as const))(
    "%s: the strip survives and the test provider answers the expected rows",
    async (_id, sample) => {
      const bytes = readFileSync(join(photoEvalDirectory("price-photo"), sample.file));
      const prepared = await prepareDocumentImage(bytes, PRICE_PHOTO_MAX_SIDE_PX);
      expect(await readSampleMarker(prepared.bytes)).toBe(sample.code);
      const output = pricePhotoOutputSchema.parse(TEST_PRICE_PHOTOS[sample.code]);
      const page = pricePhotoPage(output);
      if (sample.expected.kind !== "price_list") {
        expect(page.kind).not.toBe("rows");
        return;
      }
      expect(page.kind).toBe("rows");
      if (page.kind !== "rows") return;
      expect(page.rows).toHaveLength(sample.expected.rows.length);
      page.rows.forEach((row, index) => {
        const expected = sample.expected.rows[index]!;
        const reading = readPriceRow(row.cells, PRICE_PHOTO_ROLES, LIMITS);
        expect(reading.errors).toEqual([]);
        expect(reading.parsed.articleNorm).toBe(
          expected.article ? normalizeArticle(expected.article) : null,
        );
        expect(reading.parsed.price).toBe(expected.price);
        expect(reading.parsed.leadDays).toBe(expected.leadDays);
        expect(row.uncertain.includes("price")).toBe(expected.uncertainPrice);
      });
    },
  );

  it("scores the test provider at full marks", () => {
    const answers = new Map<string, PricePhotoOutput>(
      data.samples.map((sample) => [sample.id, TEST_PRICE_PHOTOS[sample.code]!]),
    );
    const score = scorePricePhotos(data.samples, answers);
    expect(score.exact.share).toBe(1);
    expect(score.falseRows.correct).toBe(0);
    expect(score.refusal.share).toBe(1);
    expect(score.doubtMarked.share).toBe(1);
    expect(score.silentErrors).toBe(0);
    expect(score.passes).toBe(true);
  });

  it("counts a misread article as a missed and a false row, a wrong price unmarked as a silent error", () => {
    const sample = data.samples.find((entry) => entry.id === "list-clean")!;
    const output = structuredClone(TEST_PRICE_PHOTOS[sample.code]!);
    output.rows[0]!.article = "04465-0K098";
    output.rows[1]!.price = 41_200;
    const score = scorePricePhotos([sample], new Map([[sample.id, output]]));
    expect(score.missed).toBe(1);
    expect(score.falseRows.correct).toBe(1);
    expect(score.silentErrors).toBe(1);
    expect(score.exact.correct).toBe(sample.expected.rows.length - 2);
    expect(score.passes).toBe(false);
  });
});
