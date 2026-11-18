import type { PriceImport } from "@adclub/contracts";
import { ApiError } from "@adclub/api-client";
import { supplierText } from "@adclub/i18n";
import { describe, expect, it } from "vitest";
import type { Translate } from "../i18n";
import { shrunkSize } from "./photo-shrink";
import {
  importTitle,
  pageNeedsRetake,
  pageStatusText,
  progressText,
  uploadErrorText,
} from "./price-rules";

/** The cabinet's words with their values filled in, as the screen shows them. */
const t: Translate = (key, values) =>
  supplierText("ru", key).replace(/\{(\w+)\}/g, (_, name: string) => String(values?.[name] ?? ""));

function photoImport(overrides: Partial<PriceImport> = {}): PriceImport {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    status: "parsing",
    format: "photo",
    fileName: null,
    progress: null,
    photo: {
      pages: [
        { pageNo: 1, status: "read", rows: 4, byteSize: 1, retakes: 0 },
        { pageNo: 2, status: "waiting", rows: null, byteSize: 1, retakes: 0 },
        { pageNo: 3, status: "waiting", rows: null, byteSize: 1, retakes: 0 },
      ],
      recognized: 1,
      aiWaiting: null,
    },
    ...overrides,
  } as PriceImport;
}

describe("photographed price lists in the cabinet (TASK-064)", () => {
  it("names an upload of photos by its pages", () => {
    expect(importTitle(photoImport(), t)).toBe("Фото, 3 стр.");
    expect(importTitle({ ...photoImport(), format: "xlsx", fileName: "a.xlsx" }, t)).toBe("a.xlsx");
  });

  it("says the page being read, or that it waits for AI", () => {
    expect(progressText(photoImport(), t, "ru")).toBe("Распознаём фото… страница 2 из 3");
    expect(
      progressText(
        photoImport({ photo: { ...photoImport().photo!, aiWaiting: "budget" } }),
        t,
        "ru",
      ),
    ).toBe("Ожидает распознавания");
  });

  it("names the pages to take again", () => {
    const entry = photoImport({
      status: "needs_retake",
      photo: {
        pages: [
          { pageNo: 1, status: "no_table", rows: null, byteSize: 1, retakes: 0 },
          { pageNo: 2, status: "read", rows: 4, byteSize: 1, retakes: 0 },
          { pageNo: 3, status: "unreadable", rows: null, byteSize: 1, retakes: 0 },
        ],
        recognized: 3,
        aiWaiting: null,
      },
    });
    expect(progressText(entry, t, "ru")).toBe("Фото не читается: стр. 1, 3");
    expect(entry.photo!.pages.map(pageNeedsRetake)).toEqual([true, false, true]);
    expect(pageStatusText(entry.photo!.pages[1]!, t, "ru")).toBe("Распознано: 4 строки");
  });

  it("says which page was refused and why", () => {
    const refused = new ApiError({
      code: "PRICE_IMPORT_PHOTO_INVALID",
      message: "x",
      status: 400,
      retryable: false,
      details: { page: 2, reason: "unsupported_format", limit: null },
    });
    expect(uploadErrorText(refused, t, 20)).toBe(
      "Стр. 2: формат не подходит — нужен JPEG, PNG или WebP",
    );
    const many = new ApiError({
      code: "PRICE_IMPORT_PHOTO_INVALID",
      message: "x",
      status: 400,
      retryable: false,
      details: { page: null, reason: "too_many_pages", limit: 10 },
    });
    expect(uploadErrorText(many, t, 20)).toBe("Не больше 10 страниц в одной загрузке");
  });

  it("makes a photo no larger than the server keeps", () => {
    expect(shrunkSize(4032, 3024)).toEqual({ width: 2560, height: 1920 });
    expect(shrunkSize(1200, 1600)).toEqual({ width: 1200, height: 1600 });
  });
});
