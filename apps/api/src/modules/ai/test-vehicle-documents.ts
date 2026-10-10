import sharp from "sharp";
import type { VehicleDocumentOutput } from "./ai-gateway";

/**
 * How the test AI provider "reads" a photo of a registration certificate
 * (TASK-057): deterministically and without calling anything. The
 * synthetic samples of `ai-eval/vehicle-document/` (made by
 * `scripts/vehicle-document-samples.mjs`, with made-up data only) carry a
 * small control strip in the top left corner — eleven square cells, black
 * or white: a start pair (black, white), eight bits of the sample's code
 * (black = 1, the highest bit first) and a closing black cell. The test
 * provider finds the code and answers with that sample's fields; a photo
 * without a strip — any real photo in development — is `unreadable`.
 *
 * The geometry is relative to the width of the picture, so the strip
 * survives the server making the photo smaller and writing it as JPEG
 * again. A real model sees the strip too, as a meaningless decoration.
 */

/** The strip as a share of the picture's width (the generator draws it the same way). */
export const MARKER_GEOMETRY = {
  /** Left and top margin of the first cell. */
  margin: 0.015,
  /** The side of one cell. */
  cell: 0.03,
  /** Cells: start black, start white, eight bits, closing black. */
  cells: 11,
} as const;

/**
 * Reads the code of the strip, or `null` when the picture has none: each
 * cell is averaged over its inner half, and a cell that is neither clearly
 * dark nor clearly light means there is no strip.
 */
export async function readSampleMarker(image: Uint8Array): Promise<number | null> {
  const { data, info } = await sharp(image)
    .rotate()
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const width = info.width;
  const cell = MARKER_GEOMETRY.cell * width;
  const top = MARKER_GEOMETRY.margin * width;
  if (top + cell > info.height || MARKER_GEOMETRY.margin * width + cell * 11 > width) {
    return null;
  }
  const level = (index: number): "dark" | "light" | null => {
    const x0 = MARKER_GEOMETRY.margin * width + index * cell + cell / 4;
    const y0 = top + cell / 4;
    let sum = 0;
    let count = 0;
    for (let y = Math.floor(y0); y < Math.floor(y0 + cell / 2); y += 1) {
      for (let x = Math.floor(x0); x < Math.floor(x0 + cell / 2); x += 1) {
        sum += data[y * width + x]!;
        count += 1;
      }
    }
    const mean = count === 0 ? 128 : sum / count;
    return mean < 90 ? "dark" : mean > 170 ? "light" : null;
  };
  const levels = Array.from({ length: MARKER_GEOMETRY.cells }, (_, index) => level(index));
  if (levels[0] !== "dark" || levels[1] !== "light" || levels[10] !== "dark") {
    return null;
  }
  let code = 0;
  for (let bit = 0; bit < 8; bit += 1) {
    const value = levels[2 + bit];
    if (value === null) return null;
    code = (code << 1) | (value === "dark" ? 1 : 0);
  }
  return code === 0 ? null : code;
}

const NONE = {
  make: null,
  model: null,
  year: null,
  vin: null,
  plate: null,
  engineVolumeCc: null,
  color: null,
} as const;

/**
 * What the test provider answers for each sample code: the fields of the
 * synthetic certificate as a model should read them. Made-up data — the
 * VINs and plates belong to no car. `owner` and `address` are there on
 * purpose: they stand for a provider that answers more than it was asked,
 * and the server must drop them (`vehicleDocumentOutputSchema` keeps only
 * its own keys). `vehicle-document-fixtures.test.ts` checks this table
 * against the expected values of `ai-eval/vehicle-document/samples.json`.
 */
export const TEST_VEHICLE_DOCUMENTS: Readonly<
  Record<number, VehicleDocumentOutput & { owner?: string; address?: string }>
> = {
  1: {
    documentKind: "kz_registration",
    make: "GEELY",
    model: "COOLRAY",
    year: 2024,
    vin: "L6T7844Z0RN001234",
    plate: "777 ABC 02",
    engineVolumeCc: 1477,
    color: "СЕРЫЙ",
    owner: "ТЕСТОВ ТЕСТ ТЕСТОВИЧ",
    address: "Г. АЛМАТЫ, УЛ. ВЫМЫШЛЕННАЯ, 1",
  },
  2: {
    documentKind: "kz_registration",
    make: "GEELY",
    model: "ATLAS",
    year: 2023,
    vin: "L6T79P4E5PE004567",
    plate: "123 KZA 01",
    engineVolumeCc: 1969,
    color: "БЕЛЫЙ",
    owner: "ПРИМЕРОВА ОБРАЗЦА",
  },
  3: {
    documentKind: "kz_registration",
    make: "GEELY",
    model: "MONJARO",
    year: 2024,
    vin: "L6T7944Z7RU008901",
    plate: "505 MNJ 17",
    engineVolumeCc: 1969,
    color: "ЧЕРНЫЙ",
  },
  4: {
    documentKind: "kz_registration",
    make: "CHERY",
    model: "TIGGO 7 PRO",
    year: 2022,
    vin: "LVTDB21B8ND112233",
    plate: "090 TGR 05",
    engineVolumeCc: 1498,
    color: "СИНИЙ",
  },
  5: {
    documentKind: "kz_registration",
    make: "TOYOTA",
    model: "CAMRY",
    year: 2019,
    vin: "JTNB11HK403045678",
    plate: "404 CAM 02",
    engineVolumeCc: 2487,
    color: "СЕРЕБРИСТЫЙ",
  },
  6: {
    documentKind: "kz_registration",
    make: "GEELY",
    model: "EMGRAND",
    year: 2021,
    vin: "L6T7724S1MN012345",
    plate: "211 EMG 04",
    engineVolumeCc: 1498,
    color: "КРАСНЫЙ",
  },
  7: {
    documentKind: "kz_registration",
    make: "GEELY",
    model: "ATLAS",
    year: 2018,
    vin: "L6T79P4E8JE076543",
    plate: "B 456 KLM",
    engineVolumeCc: 2378,
    color: "ТЕМНО-СИНИЙ",
  },
  8: {
    documentKind: "kz_registration",
    make: "HYUNDAI",
    model: "ACCENT",
    year: 2015,
    vin: "KMHCT41DAFU765432",
    plate: "315 ACC 09",
    engineVolumeCc: 1591,
    color: "БЕЖЕВЫЙ",
  },
  20: { documentKind: "other_document", ...NONE },
  21: { documentKind: "other_document", ...NONE },
  30: { documentKind: "not_document", ...NONE },
};
