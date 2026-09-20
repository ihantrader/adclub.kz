import { PHOTO_CARD_MAX_PX, PHOTO_THUMB_MAX_PX } from "@adclub/contracts";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { detectFormat, PhotoRejected, prepareImage } from "./photo-image";

/**
 * What the server does with an uploaded picture (TASK-013 requirement 1,
 * AC-1, AC-2): the content decides what the file is, vector and other
 * formats are refused, the metadata that came with the file is dropped,
 * and the sizes a list and a card need are produced.
 */

/** A picture of `width`×`height` with a recognisable colour. */
function picture(width: number, height: number, tint = { r: 200, g: 40, b: 40 }) {
  return sharp({ create: { width, height, channels: 3, background: tint } });
}

const jpeg = (width = 1600, height = 1200) => picture(width, height).jpeg().toBuffer();
const png = (width = 400, height = 300) => picture(width, height).png().toBuffer();
const webp = (width = 400, height = 300) => picture(width, height).webp().toBuffer();

const SVG = Buffer.from(
  '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">' +
    '<script>fetch("https://evil.example")</script></svg>',
  "utf8",
);

async function refusal(bytes: Buffer): Promise<PhotoRejected> {
  try {
    await prepareImage(bytes);
  } catch (error) {
    if (error instanceof PhotoRejected) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the picture to be refused");
}

describe("detectFormat", () => {
  it("names the format by the first bytes, whatever the file is called", async () => {
    expect(detectFormat(await jpeg(8, 8))).toBe("jpeg");
    expect(detectFormat(await png(8, 8))).toBe("png");
    expect(detectFormat(await webp(8, 8))).toBe("webp");
  });

  it("names formats the catalog does not store", async () => {
    expect(detectFormat(SVG)).toEqual({ other: "svg" });
    expect(detectFormat(Buffer.from("GIF89a....", "latin1"))).toEqual({ other: "gif" });
    expect(detectFormat(Buffer.from("BM....", "latin1"))).toEqual({ other: "bmp" });
    expect(detectFormat(Buffer.from("%PDF-1.7", "latin1"))).toEqual({ other: "pdf" });
    expect(detectFormat(await picture(8, 8).tiff().toBuffer())).toEqual({ other: "tiff" });
  });

  it("recognises a vector picture behind a byte-order mark or a comment", () => {
    const withMark = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('  <svg xmlns="http://www.w3.org/2000/svg"/>', "utf8"),
    ]);
    expect(detectFormat(withMark)).toEqual({ other: "svg" });
    expect(detectFormat(Buffer.from("<!-- made by hand --><svg />", "utf8"))).toEqual({
      other: "svg",
    });
  });

  it("says nothing at all for bytes that are not a picture", () => {
    expect(detectFormat(Buffer.from("just text, saved as photo.jpg", "utf8"))).toBeNull();
    expect(detectFormat(Buffer.from([0x00, 0x01, 0x02, 0x03]))).toBeNull();
  });
});

describe("prepareImage", () => {
  it("takes a JPEG and produces the original, the card size and the thumbnail", async () => {
    const prepared = await prepareImage(await jpeg(1600, 1200));

    expect(prepared.contentType).toBe("image/jpeg");
    expect(prepared.width).toBe(1600);
    expect(prepared.height).toBe(1200);
    expect(prepared.variants.map((variant) => variant.variant)).toEqual([
      "original",
      "card",
      "thumb",
    ]);
    const [original, card, thumb] = prepared.variants;
    expect(Math.max(card!.width, card!.height)).toBe(PHOTO_CARD_MAX_PX);
    expect(Math.max(thumb!.width, thumb!.height)).toBe(PHOTO_THUMB_MAX_PX);
    // A list must not carry the full-size picture (AC-6).
    expect(thumb!.bytes.byteLength).toBeLessThan(card!.bytes.byteLength);
    expect(card!.bytes.byteLength).toBeLessThan(original!.bytes.byteLength);
    expect(prepared.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared.byteSize).toBe(original!.bytes.byteLength);
  });

  it("keeps every variant in the format the file really is", async () => {
    for (const [bytes, type] of [
      [await png(), "image/png"],
      [await webp(), "image/webp"],
    ] as const) {
      const prepared = await prepareImage(bytes);
      expect(prepared.contentType).toBe(type);
      for (const variant of prepared.variants) {
        expect(variant.contentType).toBe(type);
        expect((await sharp(variant.bytes).metadata()).format).toBe(type.replace("image/", ""));
      }
    }
  });

  it("does not enlarge a picture smaller than the sizes it is asked for", async () => {
    const prepared = await prepareImage(await png(120, 90));
    for (const variant of prepared.variants) {
      expect(variant.width).toBe(120);
      expect(variant.height).toBe(90);
    }
  });

  it("drops the data that came with the file: coordinates, camera, comments", async () => {
    const withExif = await picture(600, 400)
      .withExif({
        IFD0: { Make: "ACME", Model: "Phone 5", Copyright: "Someone" },
        IFD3: { GPSLatitudeRef: "N", GPSLatitude: "43/1 14/1 0/1" },
      })
      .jpeg()
      .toBuffer();
    // The file really does carry it before the server touches it.
    expect((await sharp(withExif).metadata()).exif).toBeDefined();

    const prepared = await prepareImage(withExif);

    for (const variant of prepared.variants) {
      const metadata = await sharp(variant.bytes).metadata();
      expect(metadata.exif).toBeUndefined();
      expect(metadata.xmp).toBeUndefined();
      expect(variant.bytes.includes(Buffer.from("GPSLatitude", "latin1"))).toBe(false);
      expect(variant.bytes.includes(Buffer.from("ACME", "latin1"))).toBe(false);
    }
  });

  it("gives the same picture the same checksum whatever came with it (AC-2)", async () => {
    const plain = await picture(320, 240).jpeg({ quality: 90 }).toBuffer();
    const tagged = await picture(320, 240)
      .withExif({ IFD0: { Make: "ACME" } })
      .jpeg({ quality: 90 })
      .toBuffer();
    expect(plain.equals(tagged)).toBe(false);

    const [first, second] = await Promise.all([prepareImage(plain), prepareImage(tagged)]);
    expect(first.checksum).toBe(second.checksum);

    const other = await prepareImage(
      await picture(320, 240, { r: 10, g: 90, b: 200 }).jpeg().toBuffer(),
    );
    expect(other.checksum).not.toBe(first.checksum);
  });

  it("refuses a vector picture, even one claiming to be a photo", async () => {
    const refused = await refusal(SVG);
    expect(refused.reason).toBe("unsupported_format");
    expect(refused.detected).toBe("svg");
  });

  it("refuses a raster format the catalog does not store", async () => {
    const gif = await picture(20, 20).gif().toBuffer();
    expect((await refusal(gif)).detected).toBe("gif");
    const tiff = await picture(20, 20).tiff().toBuffer();
    expect((await refusal(tiff)).detected).toBe("tiff");
  });

  it("refuses bytes that are not a picture at all, .jpg or not", async () => {
    expect((await refusal(Buffer.from("this is not a picture", "utf8"))).reason).toBe(
      "not_an_image",
    );
  });

  it("refuses an empty body", async () => {
    expect((await refusal(Buffer.alloc(0))).reason).toBe("empty");
  });

  it("refuses a picture that starts right and then breaks off", async () => {
    const whole = await jpeg(400, 300);
    expect((await refusal(whole.subarray(0, 120))).reason).toBe("broken");
  });
});
