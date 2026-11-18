/**
 * Photographed pages made smaller before they are sent (TASK-064): a phone
 * takes 12 megapixels and 4–6 MB a page, the server keeps a page at most
 * `PRICE_PHOTO_MAX_SIDE_PX` on its longer side anyway. So the cabinet sends
 * each page no larger than that, as JPEG — ten pages go over a phone network
 * in seconds, not minutes. A picture the browser can't decode (HEIC outside
 * Safari) goes as it is: the server checks it and says which page it is.
 */

import { PRICE_PHOTO_MAX_SIDE_PX } from "@adclub/contracts";

/** A page smaller than this, already JPEG and within the side, goes as it is. */
const KEEP_BELOW_BYTES = 1.5 * 1024 * 1024;

/** The size a picture of `width` × `height` is drawn at: within `maxSide`, never larger. */
export function shrunkSize(
  width: number,
  height: number,
  maxSide = PRICE_PHOTO_MAX_SIDE_PX,
): { width: number; height: number } {
  const scale = Math.min(1, maxSide / Math.max(width, height, 1));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export async function shrinkPhoto(file: Blob): Promise<Blob> {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return file;
  }
  try {
    const size = shrunkSize(bitmap.width, bitmap.height);
    if (
      file.type === "image/jpeg" &&
      file.size <= KEEP_BELOW_BYTES &&
      size.width === bitmap.width &&
      size.height === bitmap.height
    ) {
      return file;
    }
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) return file;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, size.width, size.height);
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.88),
    );
    return blob ?? file;
  } finally {
    bitmap.close();
  }
}
