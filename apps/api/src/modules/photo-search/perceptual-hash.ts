import sharp from "sharp";

/**
 * A perceptual hash of a picture (TASK-068; «свой, без зависимости»): the
 * difference hash — the picture in grey shrunk to 9×8, each bit says
 * whether a pixel is brighter than its right neighbour. A picture resized,
 * compressed again or slightly recoloured keeps (almost) the same 64 bits;
 * a different picture does not. 16 hexadecimal digits.
 */
export async function differenceHash(picture: Buffer): Promise<string> {
  const { data } = await sharp(picture)
    .greyscale()
    .resize(9, 8, { fit: "fill", kernel: "lanczos3" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  let bits = 0n;
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      const left = data[row * 9 + column]!;
      const right = data[row * 9 + column + 1]!;
      bits = (bits << 1n) | (left > right ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, "0");
}
