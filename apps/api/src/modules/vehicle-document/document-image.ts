import { PHOTO_MAX_PIXELS, VEHICLE_DOCUMENT_MAX_SIDE_PX } from "@adclub/contracts";
import sharp from "sharp";
import { detectFormat } from "../catalog";

/**
 * What the server does with a photographed registration certificate before
 * it goes to the model (TASK-057 requirement 1): the rules of the catalog's
 * photos (`catalog/photo-image.ts`, ARCHITECTURE 4.22) without any storing.
 *
 * - the content decides, never the declared type: only JPEG, PNG and WebP;
 * - the picture is decoded, turned upright and written again as JPEG no
 *   larger than `VEHICLE_DOCUMENT_MAX_SIDE_PX` — which proves it is a real
 *   picture, drops everything that came with it (camera, coordinates,
 *   comments) and keeps the request to the model small;
 * - bytes in, bytes out, in memory: nothing here touches a disk, a table or
 *   the storage, and the caller drops both buffers once the model answered.
 */

export type DocumentImageRejection =
  "not_an_image" | "unsupported_format" | "broken" | "too_many_pixels";

export class DocumentImageRejected extends Error {
  constructor(readonly reason: DocumentImageRejection) {
    super(`The photo was refused: ${reason}`);
    this.name = "DocumentImageRejected";
  }
}

export interface PreparedDocumentImage {
  bytes: Buffer;
  width: number;
  height: number;
}

export async function prepareDocumentImage(input: Buffer): Promise<PreparedDocumentImage> {
  if (input.length === 0) {
    throw new DocumentImageRejected("not_an_image");
  }
  const detected = detectFormat(input);
  if (detected === null) {
    throw new DocumentImageRejected("not_an_image");
  }
  if (typeof detected !== "string") {
    throw new DocumentImageRejected("unsupported_format");
  }
  let metadata;
  try {
    metadata = await sharp(input, { limitInputPixels: PHOTO_MAX_PIXELS }).metadata();
  } catch (error) {
    throw rejectionFor(error);
  }
  if (metadata.format !== detected) {
    throw new DocumentImageRejected("unsupported_format");
  }
  const pixels = (metadata.width ?? 0) * (metadata.height ?? 0);
  if (pixels === 0) {
    throw new DocumentImageRejected("broken");
  }
  if (pixels > PHOTO_MAX_PIXELS) {
    throw new DocumentImageRejected("too_many_pixels");
  }
  try {
    // `rotate()` applies the orientation the file carried; the tag is gone
    // with the rest of the metadata, which sharp does not copy unless asked.
    const { data, info } = await sharp(input, { limitInputPixels: PHOTO_MAX_PIXELS })
      .rotate()
      .resize({
        width: VEHICLE_DOCUMENT_MAX_SIDE_PX,
        height: VEHICLE_DOCUMENT_MAX_SIDE_PX,
        fit: "inside",
        withoutEnlargement: true,
      })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    return { bytes: data, width: info.width, height: info.height };
  } catch (error) {
    throw rejectionFor(error);
  }
}

function rejectionFor(error: unknown): DocumentImageRejected {
  const message = error instanceof Error ? error.message : String(error);
  return new DocumentImageRejected(/pixel limit/i.test(message) ? "too_many_pixels" : "broken");
}
