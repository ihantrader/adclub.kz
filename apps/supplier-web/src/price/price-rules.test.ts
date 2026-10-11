import { ApiError } from "@adclub/api-client";
import type { PriceImport } from "@adclub/contracts";
import { describe, expect, it } from "vitest";
import { createTranslate } from "../translate";
import {
  assignRole,
  cellText,
  confirmErrorText,
  failureText,
  formatNumber,
  isRunning,
  missingRoleKeys,
  progressText,
  rowErrorText,
  rowsText,
  uploadErrorText,
} from "./price-rules";

const t = createTranslate("ru", null);

function apiError(code: ConstructorParameters<typeof ApiError>[0]["code"], details?: unknown) {
  return new ApiError({ code, message: code, status: 400, retryable: false, details });
}

describe("roles of the columns (S-PRICE-02)", () => {
  it("give a role to one column only: the column that had it is left unused", () => {
    expect(assignRole(["article", "name", "price", "ignore"], 3, "price")).toEqual([
      "article",
      "name",
      "ignore",
      "price",
    ]);
    expect(assignRole(["article", "name", "price"], 0, "ignore")).toEqual([
      "ignore",
      "name",
      "price",
    ]);
    expect(assignRole(["ignore", "ignore", "price"], 1, "ignore")).toEqual([
      "ignore",
      "ignore",
      "price",
    ]);
  });

  it("say what is still missing: a price, and an article or a name", () => {
    expect(missingRoleKeys(["article", "price"])).toEqual([]);
    expect(missingRoleKeys(["name", "ignore"])).toEqual(["price.columns.needPrice"]);
    expect(missingRoleKeys(["brand", "ignore"])).toEqual([
      "price.columns.needPrice",
      "price.columns.needArticleOrName",
    ]);
  });
});

describe("words of the price list", () => {
  it("tell why a file can't be read, at the upload and from the worker", () => {
    expect(
      uploadErrorText(
        apiError("PRICE_IMPORT_FILE_INVALID", { reason: "not_a_table", detected: "pdf" }),
        t,
        20,
      ),
    ).toBe("Не удалось прочитать файл. Сохраните его как .xlsx или .csv");
    expect(
      uploadErrorText(apiError("PRICE_IMPORT_FILE_INVALID", { reason: "old_excel" }), t, 20),
    ).toBe("Это старый формат .xls. Сохраните файл как .xlsx");
    expect(uploadErrorText(apiError("PAYLOAD_TOO_LARGE"), t, 20)).toBe(
      "Файл больше 20 МБ. Уменьшите его или разделите прайс на несколько файлов",
    );
    expect(
      uploadErrorText(
        apiError("RATE_LIMITED", {
          limit: "price_import_uploads_per_supplier",
          retryAfterSeconds: 130,
        }),
        t,
        20,
      ),
    ).toBe("Слишком много загрузок. Попробуйте через 3 мин");
    expect(failureText({ reason: "too_many_rows", limit: 50_000 }, t)).toBe(
      "Слишком много строк: не больше 50000. Разделите прайс на несколько файлов",
    );
    expect(failureText({ reason: "timeout", limit: null }, t)).toBe(
      "Файл обрабатывался слишком долго. Загрузите его снова",
    );
    expect(confirmErrorText(apiError("PRICE_IMPORT_STATE", { status: "parsing" }), t)).toBe(
      "Файл ещё обрабатывается или не прочитан — обновите страницу",
    );
  });

  it("tell what is wrong with a row", () => {
    const base = { text: null, value: null, min: null, max: null };
    expect(rowErrorText({ ...base, code: "price_missing" }, t)).toBe("Нет цены");
    expect(rowErrorText({ ...base, code: "price_not_number", text: "по запросу" }, t)).toBe(
      "Цена — не число: «по запросу»",
    );
    expect(
      rowErrorText(
        { ...base, code: "price_out_of_range", value: 150_000_000, min: 1, max: 100_000_000 },
        t,
      ),
    ).toBe(
      `Цена ${formatNumber(150_000_000)} ₸ — вне допустимого: от 1 до ${formatNumber(100_000_000)} ₸`,
    );
    expect(rowErrorText({ ...base, code: "no_article_or_name" }, t)).toBe(
      "Нет ни артикула, ни названия",
    );
  });

  it("count rows in the right form of the noun", () => {
    expect(rowsText("ru", 1, t)).toBe("1 строка");
    expect(rowsText("ru", 3, t)).toBe("3 строки");
    expect(rowsText("ru", 1240, t)).toBe(`${formatNumber(1240)} строк`);
    expect(formatNumber(1240)).toBe("1\u202f240");
  });

  it("show a cell as the file holds it", () => {
    expect(cellText(12500.5)).toBe("12500,5");
    expect(cellText("по запросу")).toBe("по запросу");
    expect(cellText(null)).toBe("");
  });

  it("follow the reading of a file", () => {
    const entry = {
      status: "parsing",
      progress: { done: 3000, total: null },
      stats: null,
      failure: null,
    } as unknown as PriceImport;
    expect(isRunning("parsing")).toBe(true);
    expect(isRunning("columns")).toBe(false);
    expect(progressText(entry, t, "ru")).toBe(`Прочитано строк: ${formatNumber(3000)}`);
    expect(
      progressText(
        {
          ...entry,
          status: "parsed",
          progress: null,
          stats: { rows: 1250, dataRows: 1240, serviceRows: 9, parsedRows: 1228, errorRows: 12 },
        },
        t,
        "ru",
      ),
    ).toBe(`${formatNumber(1240)} строк, ошибки в строках — 12`);
  });
});
