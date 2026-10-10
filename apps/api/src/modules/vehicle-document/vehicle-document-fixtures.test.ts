import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeKzPlate } from "@adclub/domain";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { readSampleMarker, TEST_VEHICLE_DOCUMENTS, vehicleDocumentOutputSchema } from "../ai";
import { loadDocumentEvalData, vehicleDocumentEvalDirectory } from "./eval/document-eval-data";
import { DocumentImageRejected, prepareDocumentImage } from "./document-image";
import { matchColor } from "./document-matching";
import { DocumentProofs } from "./document-proofs";

/**
 * The synthetic sample set (`ai-eval/vehicle-document/`, made by
 * `scripts/vehicle-document-samples.mjs`) and the test AI provider read it
 * the same way: every sample's control strip survives the server's own
 * preparation of the photo, and what the test provider answers for a code
 * is what the set expects of that sample.
 */
describe("synthetic samples and the test provider", () => {
  const data = loadDocumentEvalData();

  it("has the forms, the variants and the other pictures the task names", () => {
    const forms = new Set(data.samples.map((sample) => sample.form));
    expect(forms).toEqual(new Set(["new", "old", "ru_sts", "kz_license", "not_document"]));
    const variants = new Set(data.samples.map((sample) => sample.variant));
    expect(variants).toEqual(new Set(["clean", "glare", "tilt", "blur", "occluded", "lowres"]));
  });

  it.each(loadDocumentEvalData().samples.map((sample) => [sample.id, sample] as const))(
    "%s: the strip survives the preparation and names a sample the test provider knows",
    async (_id, sample) => {
      const bytes = readFileSync(join(vehicleDocumentEvalDirectory(), sample.file));
      const prepared = await prepareDocumentImage(bytes);
      expect(Math.max(prepared.width, prepared.height)).toBeLessThanOrEqual(1600);
      // Nothing that came with the file survives: no EXIF, no ICC, no comment.
      const meta = await sharp(prepared.bytes).metadata();
      expect(meta.exif).toBeUndefined();
      expect(meta.icc).toBeUndefined();
      expect(await readSampleMarker(prepared.bytes)).toBe(sample.code);
      const known = TEST_VEHICLE_DOCUMENTS[sample.code]!;
      const output = vehicleDocumentOutputSchema.parse(known);
      expect(output.documentKind).toBe(sample.expected.documentKind);
      if (sample.expected.documentKind === "kz_registration") {
        expect(output.make).toBe(sample.expected.make);
        expect(output.model).toBe(sample.expected.model);
        expect(output.year).toBe(sample.expected.year);
        expect(normalizeKzPlate(output.plate)).toBe(sample.expected.plate);
        expect(output.engineVolumeCc).toBe(sample.expected.engineVolumeCc);
        expect(matchColor(output.color)).toBe(sample.expected.colorId);
        // A thumb over the VIN: the set expects none; the test provider still
        // "sees" it, as a model that guesses would — the checks of the
        // comparison count exactly that.
        if (sample.expected.vin !== null) expect(output.vin).toBe(sample.expected.vin);
      }
    },
  );

  it("drops whatever a provider adds beyond the fields: the owner, the address", () => {
    const parsed = vehicleDocumentOutputSchema.parse(TEST_VEHICLE_DOCUMENTS[1]);
    expect(parsed).not.toHaveProperty("owner");
    expect(parsed).not.toHaveProperty("address");
    expect(JSON.stringify(parsed)).not.toContain("ТЕСТОВ");
  });

  it("reads no strip on a picture without one", async () => {
    const plain = await sharp({
      create: { width: 800, height: 600, channels: 3, background: "#777777" },
    })
      .jpeg()
      .toBuffer();
    expect(await readSampleMarker(plain)).toBeNull();
  });
});

describe("the photo is checked by its content", () => {
  it("refuses a text, an SVG, a GIF and an empty body", async () => {
    await expect(prepareDocumentImage(Buffer.from("hello, not a picture"))).rejects.toMatchObject({
      reason: "not_an_image",
    });
    await expect(prepareDocumentImage(Buffer.from("<svg xmlns='x'></svg>"))).rejects.toMatchObject({
      reason: "unsupported_format",
    });
    await expect(prepareDocumentImage(Buffer.from("GIF89a....."))).rejects.toMatchObject({
      reason: "unsupported_format",
    });
    await expect(prepareDocumentImage(Buffer.alloc(0))).rejects.toBeInstanceOf(
      DocumentImageRejected,
    );
  });

  it("refuses a cut-off JPEG as broken", async () => {
    const whole = await sharp({
      create: { width: 400, height: 300, channels: 3, background: "#ffffff" },
    })
      .jpeg()
      .toBuffer();
    await expect(prepareDocumentImage(whole.subarray(0, 60))).rejects.toMatchObject({
      reason: "broken",
    });
  });

  it("drops the camera metadata of a photo", async () => {
    const withExif = await sharp({
      create: { width: 2400, height: 1800, channels: 3, background: "#ffffff" },
    })
      .withMetadata({ exif: { IFD0: { Make: "Camera", Model: "Phone 1" } } })
      .jpeg()
      .toBuffer();
    expect((await sharp(withExif).metadata()).exif).toBeDefined();
    const prepared = await prepareDocumentImage(withExif);
    expect((await sharp(prepared.bytes).metadata()).exif).toBeUndefined();
    expect(prepared.width).toBe(1600);
  });
});

describe("the proof of a shown document", () => {
  const proofs = new DocumentProofs({
    session: { tokenSecret: "a-test-secret-of-at-least-thirty-two-characters" },
  } as never);
  const other = new DocumentProofs({
    session: { tokenSecret: "another-test-secret-of-thirty-two-characters!" },
  } as never);

  it("is read back as the moment it was issued", () => {
    const at = new Date("2026-10-10T08:00:00Z");
    expect(proofs.read(proofs.issue(at), at)?.toISOString()).toBe("2026-10-10T08:00:00.000Z");
  });

  it("is refused when changed, made by another key or made up", () => {
    const at = new Date("2026-10-10T08:00:00Z");
    const proof = proofs.issue(at);
    const [prefix, seconds, nonce, signature] = proof.split(".");
    expect(proofs.read(`${prefix}.${Number(seconds) - 1000}.${nonce}.${signature}`, at)).toBeNull();
    expect(proofs.read(other.issue(at), at)).toBeNull();
    expect(proofs.read("vd1.1.abcdefgh.abcdefghijklmnop", at)).toBeNull();
    expect(proofs.read("anything", at)).toBeNull();
  });
});
