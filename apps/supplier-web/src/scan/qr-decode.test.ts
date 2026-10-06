import { ORDER_QR_PREFIX } from "@adclub/contracts";
import { createQrMatrix } from "@adclub/ui-core";
import jsQR from "jsqr";
import { describe, expect, it } from "vitest";
import { cropOf } from "./camera";
import { createScanGate, credentialOfScan } from "./scan-rules";

/**
 * A frame of a camera looking at the customer's screen: the QR exactly as
 * the app draws it (`createQrMatrix`, level M, quiet zone 4 modules,
 * black on white — DESIGN 7.10) in the middle of a grey frame.
 */
function frame(text: string, width = 640, height = 480, module = 6) {
  const matrix = createQrMatrix(text);
  const side = (matrix.length + 8) * module;
  const x0 = Math.floor((width - side) / 2);
  const y0 = Math.floor((height - side) / 2);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inside = x >= x0 && x < x0 + side && y >= y0 && y < y0 + side;
      const row = Math.floor((y - y0) / module) - 4;
      const col = Math.floor((x - x0) / module) - 4;
      const dark = inside && matrix[row]?.[col] === true;
      const value = !inside ? 120 : dark ? 0 : 255;
      const at = (y * width + x) * 4;
      data[at] = data[at + 1] = data[at + 2] = value;
      data[at + 3] = 255;
    }
  }
  return { data, width, height };
}

/** The square the decoder looks at (`cropOf`), at its scale, by nearest pixel. */
function cropped(image: ReturnType<typeof frame>) {
  const { sx, sy, size, scaled } = cropOf(image.width, image.height);
  const data = new Uint8ClampedArray(scaled * scaled * 4);
  for (let y = 0; y < scaled; y += 1) {
    for (let x = 0; x < scaled; x += 1) {
      const from =
        ((sy + Math.floor((y * size) / scaled)) * image.width +
          sx +
          Math.floor((x * size) / scaled)) *
        4;
      data.set(image.data.subarray(from, from + 4), (y * scaled + x) * 4);
    }
  }
  return { data, size: scaled };
}

describe("decoding the customer's QR on the device (S-SCAN-01)", () => {
  it("reads the club's QR from the middle of the frame, as the decoder crops it", () => {
    const qr = `${ORDER_QR_PREFIX}cy-juginzi6PSejHMGrP2A`;
    const { data, size } = cropped(frame(qr));
    const found = jsQR(data, size, size, { inversionAttempts: "dontInvert" });
    expect(found?.data).toBe(qr);
    expect(credentialOfScan(found!.data)).toEqual({ qr });
  });

  it("reads somebody else's QR as somebody else's, and asks the server once for the club's one held in view", () => {
    const { data, size } = cropped(frame("https://example.com/menu"));
    const text = jsQR(data, size, size, { inversionAttempts: "dontInvert" })?.data;
    expect(text).toBe("https://example.com/menu");
    expect(credentialOfScan(text!)).toBeNull();

    const gate = createScanGate();
    const qr = `${ORDER_QR_PREFIX}w97VBxK0hIJGT6Ps8t27iw`;
    const club = cropped(frame(qr));
    const verdicts = Array.from({ length: 15 }, (_, index) => {
      const read = jsQR(club.data, club.size, club.size, { inversionAttempts: "dontInvert" })?.data;
      return gate.seen(read!, index * 200);
    });
    expect(verdicts.filter((verdict) => verdict === "act")).toHaveLength(1);
  });
});
