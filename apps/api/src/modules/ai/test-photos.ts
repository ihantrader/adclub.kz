import type { DashboardOutput, PartPhotoOutput } from "./ai-gateway";

/**
 * What the test AI provider answers for the synthetic photos of TASK-058,
 * by the code of their control strip (the strip of `test-vehicle-documents.ts`,
 * drawn by `scripts/dashboard-samples.mjs` and `scripts/part-photo-samples.mjs`).
 * A photo without a strip — any real photo in development — is unreadable.
 * `photo-fixtures.test.ts` checks these tables against the expected values
 * of `ai-eval/dashboard/samples.json` and `ai-eval/part-photo/samples.json`.
 *
 * A covered or blurred sample is answered as a model that guesses would —
 * with the value under the thumb — so the checks of the comparison have
 * something to count (as the hidden VIN of the certificate).
 */

function dashboard(
  totalMileage: number,
  unit: "km" | "mi" = "km",
  tripMeterSeen = false,
): DashboardOutput {
  return { kind: "dashboard", totalMileage, unit, confidence: 0.94, tripMeterSeen };
}

const NOT_DASHBOARD: DashboardOutput = {
  kind: "not_dashboard",
  totalMileage: null,
  unit: null,
  confidence: 0.9,
  tripMeterSeen: false,
};

const UNREADABLE_DASHBOARD: DashboardOutput = {
  kind: "unreadable",
  totalMileage: null,
  unit: null,
  confidence: 0.6,
  tripMeterSeen: false,
};

export const TEST_DASHBOARDS: Readonly<Record<number, DashboardOutput & { extra?: string }>> = {
  // `extra` stands for a provider that answers more than it was asked: dropped by the schema.
  1: { ...dashboard(45_200), extra: "the outside temperature is -18" },
  2: dashboard(45_200),
  3: dashboard(45_200),
  4: dashboard(128_450),
  5: dashboard(128_450),
  6: dashboard(32_000),
  7: dashboard(7_350),
  8: dashboard(210_987),
  9: dashboard(64_310),
  10: dashboard(91_200),
  11: dashboard(28_087, "mi"),
  12: dashboard(61_500, "mi"),
  13: dashboard(89_400, "km", true),
  14: dashboard(156_020, "km", true),
  15: dashboard(503_120, "km", true),
  16: UNREADABLE_DASHBOARD,
  17: UNREADABLE_DASHBOARD,
  18: dashboard(18_750),
  19: dashboard(12),
  20: dashboard(73_004, "km", true),
  30: NOT_DASHBOARD,
  31: NOT_DASHBOARD,
  32: NOT_DASHBOARD,
};

/** The answer for a photo without a strip, or in the mode `unreadable`. */
export const TEST_DASHBOARD_UNREADABLE = UNREADABLE_DASHBOARD;
/** The answer in the mode `not_dashboard`. */
export const TEST_DASHBOARD_NOT_DASHBOARD = NOT_DASHBOARD;

function part(articles: readonly string[], brand: string, labelText: string): PartPhotoOutput {
  return {
    kind: "article_found",
    articles: articles.map((text, index) => ({ text, confidence: index === 0 ? 0.95 : 0.8 })),
    brand,
    labelText,
  };
}

function noArticle(brand: string | null): PartPhotoOutput {
  return { kind: "no_article", articles: [], brand, labelText: null };
}

const UNREADABLE_PART: PartPhotoOutput = {
  kind: "unreadable",
  articles: [],
  brand: null,
  labelText: null,
};

export const TEST_PART_PHOTOS: Readonly<Record<number, PartPhotoOutput & { extra?: string }>> = {
  1: { ...part(["04465-0K090"], "GEELY", "Колодки тормозные передние"), extra: "Qty 1 SET" },
  2: part(["04465-0K090"], "GEELY", "Колодки тормозные передние"),
  3: part(["04465-0K090"], "GEELY", "Колодки тормозные передние"),
  4: part(["GDB3534"], "TRW", "Brake pad set"),
  5: part(["GDB3534", "04465-0K090"], "TRW", "Brake pad set"),
  6: part(["044650K090"], "GEELY", "PAD KIT FR"),
  7: part(["4050068800"], "GEELY", "Колодки тормозные задние"),
  8: part(["FEB35074"], "FEBI", "Фильтр масляный"),
  9: part(["11818-0249"], "GEELY", "Фильтр воздушный"),
  10: part(["64642-0212"], "GEELY", "Датчик"),
  11: part(["MAN67527"], "MANN", "Oil filter"),
  12: part(["SAC28522"], "SACHS", "Амортизатор"),
  13: part(["NGK26258"], "NGK", "Spark plug"),
  14: part(["GDB3534"], "TRW", "Brake pad set"),
  15: part(["04465 0K090"], "GEELY", "Колодки"),
  16: part(["04465-0K090"], "GEELY", "Колодки тормозные передние"),
  17: UNREADABLE_PART,
  18: part(["MAN67527"], "MANN", "Oil filter"),
  19: part(["FEB35074"], "FEBI", "Фильтр масляный"),
  30: noArticle("SHELL"),
  31: noArticle("GEELY"),
  32: noArticle(null),
  33: UNREADABLE_PART,
};

/** The answer for a photo without a strip, or in the mode `unreadable`. */
export const TEST_PART_PHOTO_UNREADABLE = UNREADABLE_PART;
/** The answer in the mode `no_article`. */
export const TEST_PART_PHOTO_NO_ARTICLE = noArticle(null);
