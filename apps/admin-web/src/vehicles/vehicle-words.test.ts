import { ApiError } from "@adclub/api-client";
import { describe, expect, it } from "vitest";
import {
  archivedParent,
  conflictText,
  countText,
  importFileErrorText,
  MODELS,
  reasonText,
  rowNumbersText,
  templateFileText,
  uploadContentType,
  vehicleErrorView,
} from "./vehicle-words";

const ID = "0b6c9f1e-2a3d-4c5b-8e7f-9a0b1c2d3e4f";

function apiError(status: number, code: string, details?: unknown, message = "") {
  return new ApiError({ status, code, message, details } as ConstructorParameters<
    typeof ApiError
  >[0]);
}

describe("the server's answers about cars, in words (TASK-035.B)", () => {
  it("puts a duplicate at its field with «Открыть» to the existing record", () => {
    expect(
      vehicleErrorView(
        apiError(409, "VEHICLE_DUPLICATE", { entity: "make", existingId: ID, spelling: "GEELY" }),
      ),
    ).toEqual({
      text: "«GEELY» уже занято. Такая марка уже есть",
      field: "name",
      link: { href: `/vehicles/makes/${ID}`, label: "Открыть" },
      currentVersion: null,
      existingId: ID,
    });
    expect(
      vehicleErrorView(
        apiError(409, "VEHICLE_DUPLICATE", {
          entity: "modification",
          existingId: ID,
          spelling: null,
        }),
        { generationId: "gen" },
      ).link,
    ).toEqual({ href: `/vehicles/generations/gen?highlight=${ID}`, label: "Открыть" });
    expect(
      vehicleErrorView(
        apiError(409, "VEHICLE_DUPLICATE", { entity: "option", existingId: ID, spelling: "Седан" }),
        { kind: "body" },
      ),
    ).toMatchObject({
      field: "names",
      link: { href: `/vehicles/options?kind=body&highlight=${ID}` },
    });
  });

  it("says the years of a modification lie within its generation's, at «Год с»", () => {
    expect(
      vehicleErrorView(
        apiError(400, "VEHICLE_YEARS_INVALID", {
          reason: "outside_generation",
          generationYears: { from: 2023, to: null },
          modificationIds: [],
        }),
      ),
    ).toMatchObject({
      text: "Годы модификации должны быть в пределах лет поколения: 2023–н.в.",
      field: "yearFrom",
    });
    expect(
      vehicleErrorView(
        apiError(400, "VEHICLE_YEARS_INVALID", {
          reason: "order",
          generationYears: null,
          modificationIds: [],
        }),
      ),
    ).toMatchObject({ field: "yearTo" });
  });

  it("names the archived parent to restore first — the topmost one", () => {
    const make = { id: "m", name: "Haval", status: "archived" as const };
    const model = { id: "o", name: "Jolion", status: "archived" as const };
    expect(
      vehicleErrorView(apiError(409, "VEHICLE_PARENT_ARCHIVED"), { parents: { make, model } }).text,
    ).toBe("Сначала восстановите марку «Haval»");
    expect(
      vehicleErrorView(apiError(409, "VEHICLE_PARENT_ARCHIVED"), {
        parents: { make: { ...make, status: "active" }, model },
      }).text,
    ).toBe("Сначала восстановите модель «Jolion»");
    expect(archivedParent({ make: { ...make, status: "active" } })).toBeNull();
  });

  it("keeps the stored version of a colleague's change for «Обновить данные»", () => {
    expect(
      vehicleErrorView(apiError(409, "VEHICLE_VERSION_CONFLICT", { currentVersion: 4 })),
    ).toMatchObject({ currentVersion: 4 });
    expect(conflictText("Айгерим")).toBe(
      "Эти данные только что изменил Айгерим. Обновите страницу",
    );
  });

  it("puts an archived engine at its field", () => {
    expect(
      vehicleErrorView(apiError(409, "VEHICLE_REFERENCE_ARCHIVED", { field: "engineId" })),
    ).toMatchObject({ field: "engineId" });
  });

  it("keeps the engine a colleague just added, to choose it from a modification (TASK-035.C)", () => {
    expect(
      vehicleErrorView(
        apiError(409, "VEHICLE_DUPLICATE", { entity: "engine", existingId: ID, spelling: "H4J" }),
      ),
    ).toMatchObject({
      text: "«H4J» уже занято. Такой двигатель уже есть",
      field: "code",
      existingId: ID,
    });
  });

  it("says a year can't be later than the current one, at its field (TASK-035.C)", () => {
    const message = "The year can't be later than the current year (2026)";
    expect(
      vehicleErrorView(apiError(400, "VALIDATION_ERROR", [{ path: "yearTo", message }], message)),
    ).toMatchObject({
      text: "Год выпуска не может быть позже текущего — обновите страницу",
      field: "yearTo",
    });
  });

  it("counts in the right form of the word", () => {
    expect(countText(1, MODELS)).toBe("1 модель");
    expect(countText(3, MODELS)).toBe("3 модели");
    expect(countText(6, MODELS)).toBe("6 моделей");
    expect(countText(11, MODELS)).toBe("11 моделей");
    expect(countText(22, MODELS)).toBe("22 модели");
  });
});

describe("the import file and its rows, in words (TASK-035.B)", () => {
  const invalid = (details: object) =>
    importFileErrorText(
      apiError(400, "VEHICLE_IMPORT_FILE_INVALID", {
        detected: null,
        columns: [],
        line: null,
        limit: null,
        ...details,
      }),
    );

  it("says what is wrong with a file the server didn't take", () => {
    expect(invalid({ reason: "unsupported_format", detected: "xlsx" })).toMatch(
      /^Это не CSV — сохраните таблицу как CSV UTF-8/,
    );
    expect(invalid({ reason: "empty" })).toBe("Файл пустой");
    expect(invalid({ reason: "no_rows" })).toBe("В файле только заголовок — нет ни одной строки");
    expect(invalid({ reason: "unknown_columns", columns: ["colour"] })).toBe(
      "Лишние колонки: colour. Уберите их или исправьте заголовок по шаблону",
    );
    expect(invalid({ reason: "duplicate_columns", columns: ["make"] })).toBe(
      "Колонки повторяются: make",
    );
    expect(invalid({ reason: "missing_columns", columns: ["market"] })).toMatch(
      /^Нет обязательных колонок: market/,
    );
    expect(invalid({ reason: "encoding", detected: "unknown" })).toMatch(/UTF-8/);
    expect(invalid({ reason: "malformed", line: 7 })).toBe(
      "Файл повреждён: в строке 7 не закрыта кавычка",
    );
    expect(invalid({ reason: "too_many_rows", limit: 10000 })).toMatch(/10\s000/);
    expect(
      importFileErrorText(
        apiError(413, "PAYLOAD_TOO_LARGE", undefined, "The file is larger than the limit of 5 MB"),
      ),
    ).toBe("Файл больше допустимого (5 МБ) — разделите его на несколько");
  });

  it("explains a rejected row by its column, its value and the reason", () => {
    expect(
      reasonText(
        { code: "unknown_option", column: "body", message: "…" },
        { body: "кабриолет-пикап" },
      ),
    ).toBe(
      "«Кузов»: «кабриолет-пикап» — нет такого значения в справочном списке (из файла они не создаются)",
    );
    expect(
      reasonText({
        code: "duplicate_in_file",
        column: null,
        message: "The same modification as row 2 of this file",
      }),
    ).toBe("Повтор строки 2 этого файла");
  });

  it("writes row numbers short", () => {
    expect(rowNumbersText([6, 3, 4, 5])).toBe("3–6");
    expect(rowNumbersText([3, 5, 9, 10])).toBe("3, 5, 9–10");
    expect(rowNumbersText([])).toBe("");
  });

  it("sends a file of an unknown type as bytes and lets the server decide", () => {
    expect(uploadContentType("text/csv")).toBe("text/csv");
    expect(uploadContentType("application/vnd.ms-excel")).toBe("application/vnd.ms-excel");
    expect(uploadContentType("")).toBe("application/octet-stream");
    expect(uploadContentType("application/pdf")).toBe("application/octet-stream");
  });

  it("gives the template a byte order mark once, so Excel reads it as UTF-8", () => {
    expect(templateFileText("make,model").charCodeAt(0)).toBe(0xfeff);
    expect(templateFileText(templateFileText("make")).length).toBe("make".length + 1);
  });
});
