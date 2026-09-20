import { createHash } from "node:crypto";
import {
  PHOTO_CARD_MAX_PX,
  PHOTO_MAX_PIXELS,
  PHOTO_THUMB_MAX_PX,
  type CatalogPhotoInvalidReason,
  type ItemPhotoVariant,
} from "@adclub/contracts";
import sharp from "sharp";

/**
 * What the server does with an uploaded picture before it is stored
 * (TASK-013 requirement 1; ARCHITECTURE 4.22). Pure: bytes in, bytes out,
 * no database and no storage — so every rule below is a unit test.
 *
 * The rules:
 * - the content decides, never the name or the declared `Content-Type`:
 *   the first bytes say which format it really is;
 * - raster only. A vector file (SVG above all) can carry scripts and is
 *   refused whatever it claims to be;
 * - the picture is decoded and written again, which both proves it is a
 *   real picture and drops everything that came with it — camera model,
 *   shooting coordinates, comments (ARCHITECTURE 15.2). Only the
 *   orientation is kept, by turning the picture itself;
 * - three sizes are produced at once (ARCHITECTURE 4.22): the original for
 *   moderation, a card-size picture and a thumbnail, so a list never
 *   carries the full-size file.
 */

/** A refused upload: the reason travels to the client as `CATALOG_PHOTO_INVALID`. */
export class PhotoRejected extends Error {
  constructor(
    readonly reason: CatalogPhotoInvalidReason,
    readonly detected?: string,
  ) {
    super(`The picture was refused: ${reason}${detected ? ` (${detected})` : ""}`);
    this.name = "PhotoRejected";
  }
}

export interface PreparedVariant {
  variant: ItemPhotoVariant;
  bytes: Buffer;
  contentType: string;
  width: number;
  height: number;
}

export interface PreparedImage {
  /** The type the content really is, not the one the request declared. */
  contentType: string;
  /** SHA-256 of the stored original, in lower-case hexadecimal. */
  checksum: string;
  width: number;
  height: number;
  byteSize: number;
  /** `original`, `card` and `thumb`, in that order. */
  variants: PreparedVariant[];
}

/** Formats the catalog stores, by what the first bytes say. */
type RasterFormat = "jpeg" | "png" | "webp";

const CONTENT_TYPE: Record<RasterFormat, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/** The byte-order mark a text file may start with, built rather than typed. */
const BYTE_ORDER_MARK = new RegExp(`^${String.fromCharCode(0xfeff)}`, "u");

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) {
    return false;
  }
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return Buffer.from(bytes.subarray(offset, offset + length)).toString("latin1");
}

/**
 * What the bytes actually are: one of the formats we store, or the name of
 * something we don't (for the error the administrator sees). `null` — not a
 * picture at all.
 */
export function detectFormat(bytes: Uint8Array): RasterFormat | { other: string } | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return "jpeg";
  }
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "png";
  }
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    return "webp";
  }
  if (ascii(bytes, 0, 4) === "GIF8") {
    return { other: "gif" };
  }
  if (startsWith(bytes, [0x42, 0x4d])) {
    return { other: "bmp" };
  }
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) {
    return { other: "tiff" };
  }
  if (ascii(bytes, 4, 4) === "ftyp") {
    // AVIF, HEIC and friends: real pictures, but not formats every client
    // of ours can show — they are refused by name rather than as rubbish.
    return { other: ascii(bytes, 8, 4).trim().toLowerCase() || "iso-media" };
  }
  if (ascii(bytes, 0, 5) === "%PDF-") {
    return { other: "pdf" };
  }
  // A vector picture is text: it may start with a byte-order mark, an XML
  // declaration, comments or whitespace before `<svg`.
  const head = Buffer.from(bytes.subarray(0, 1024))
    .toString("utf8")
    .replace(BYTE_ORDER_MARK, "")
    .trimStart();
  if (/^<(\?xml|!--|!DOCTYPE\s+svg|svg[\s>])/i.test(head)) {
    return { other: "svg" };
  }
  return null;
}

/** The size a picture is resized to, keeping its proportions. */
const VARIANTS: { variant: ItemPhotoVariant; maxSide: number | null }[] = [
  { variant: "original", maxSide: null },
  { variant: "card", maxSide: PHOTO_CARD_MAX_PX },
  { variant: "thumb", maxSide: PHOTO_THUMB_MAX_PX },
];

async function encode(
  input: Buffer,
  format: RasterFormat,
  maxSide: number | null,
): Promise<{ bytes: Buffer; width: number; height: number }> {
  // `rotate()` without an angle applies the orientation the file carried
  // and writes the result upright — the tag itself is gone with the rest
  // of the metadata, which sharp does not copy unless asked to.
  let pipeline = sharp(input, { limitInputPixels: PHOTO_MAX_PIXELS }).rotate();
  if (maxSide !== null) {
    pipeline = pipeline.resize({
      width: maxSide,
      height: maxSide,
      fit: "inside",
      withoutEnlargement: true,
    });
  }
  switch (format) {
    case "jpeg":
      pipeline = pipeline.jpeg({ quality: 88, mozjpeg: true });
      break;
    case "png":
      pipeline = pipeline.png({ compressionLevel: 9 });
      break;
    case "webp":
      pipeline = pipeline.webp({ quality: 88 });
      break;
  }
  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  return { bytes: data, width: info.width, height: info.height };
}

/**
 * Checks an uploaded picture by its content and prepares everything that
 * is stored for it. Throws `PhotoRejected` with the reason the client is
 * told; anything else is a real failure of the process.
 */
export async function prepareImage(input: Buffer): Promise<PreparedImage> {
  if (input.length === 0) {
    throw new PhotoRejected("empty");
  }
  const detected = detectFormat(input);
  if (detected === null) {
    throw new PhotoRejected("not_an_image");
  }
  if (typeof detected !== "string") {
    throw new PhotoRejected("unsupported_format", detected.other);
  }

  let metadata;
  try {
    metadata = await sharp(input, { limitInputPixels: PHOTO_MAX_PIXELS }).metadata();
  } catch (error) {
    throw rejectionFor(error);
  }
  if (metadata.format !== detected) {
    // The first bytes and the decoder disagree: not something to store.
    throw new PhotoRejected("unsupported_format", metadata.format ?? "unknown");
  }
  const pixels = (metadata.width ?? 0) * (metadata.height ?? 0);
  if (pixels === 0) {
    throw new PhotoRejected("broken");
  }
  if (pixels > PHOTO_MAX_PIXELS) {
    throw new PhotoRejected("too_many_pixels", `${metadata.width}x${metadata.height}`);
  }

  const contentType = CONTENT_TYPE[detected];
  const variants: PreparedVariant[] = [];
  for (const { variant, maxSide } of VARIANTS) {
    let encoded;
    try {
      encoded = await encode(input, detected, maxSide);
    } catch (error) {
      throw rejectionFor(error);
    }
    variants.push({ variant, contentType, ...encoded });
  }

  const original = variants[0]!;
  return {
    contentType,
    checksum: createHash("sha256").update(original.bytes).digest("hex"),
    width: original.width,
    height: original.height,
    byteSize: original.bytes.byteLength,
    variants,
  };
}

/**
 * A failure of the decoder is the file's fault, not the server's: a
 * truncated or damaged picture of a format we do take, or one that unpacks
 * into more pixels than allowed.
 */
function rejectionFor(error: unknown): PhotoRejected {
  const message = error instanceof Error ? error.message : String(error);
  if (/pixel limit/i.test(message)) {
    return new PhotoRejected("too_many_pixels");
  }
  return new PhotoRejected("broken");
}
