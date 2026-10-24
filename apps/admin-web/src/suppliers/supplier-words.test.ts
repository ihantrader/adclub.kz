import { ApiError, type ApiErrorCode } from "@adclub/api-client";
import type { PriceImport } from "@adclub/contracts";
import { kzBinCheckDigit } from "@adclub/domain";
import { describe, expect, it } from "vitest";
import {
  binProblem,
  consentVersionText,
  ipText,
  leadSearchOf,
  offerPriceLine,
  priceImportTypeText,
  sessionGroups,
  hiddenPhone,
  leadMoves,
  PRICE_IMPORT_STATUS_TEXT,
  priceImportFailureText,
  priceImportNumbers,
  mobilePhone,
  supplierErrorView,
  waitText,
} from "./supplier-words";

const error = (status: number, code: ApiErrorCode, details?: unknown) =>
  new ApiError({ status, code, message: "", details, retryable: false });

function validBin(first11: string): string {
  return `${first11}${kzBinCheckDigit(first11)}`;
}

describe("the words of «Поставщики» (TASK-036)", () => {
  it("hides a number partly, as SCREENS 7.0 shows it", () => {
    expect(hiddenPhone("+77771234512")).toBe("+7 777 *** ** 12");
    expect(hiddenPhone("+77055550101")).toBe("+7 705 *** ** 01");
    expect(hiddenPhone(null)).toBe("—");
    expect(hiddenPhone("123")).toBe("***");
    // TASK-036.B: a number the server already hid is shown as it came.
    expect(hiddenPhone("+7 705 *** ** 01")).toBe("+7 705 *** ** 01");
  });

  it("offers only the funnel's moves the domain allows, a reason where it asks", () => {
    expect(leadMoves("new")).toEqual([
      { to: "contacted", reasonRequired: false },
      { to: "meeting", reasonRequired: false },
      { to: "contract_signed", reasonRequired: false },
      { to: "rejected", reasonRequired: true },
    ]);
    expect(leadMoves("rejected")).toEqual([
      { to: "new", reasonRequired: true },
      { to: "contacted", reasonRequired: true },
      { to: "meeting", reasonRequired: true },
      { to: "contract_signed", reasonRequired: true },
    ]);
    expect(leadMoves("onboarded")).toEqual([]);
    expect(leadMoves("contract_signed").map((move) => move.to)).not.toContain("onboarded");
  });

  it("checks a БИН with its check digit before asking the server", () => {
    const bin = validBin("08074000012");
    expect(binProblem(bin)).toBeNull();
    expect(binProblem(`${bin.slice(0, 6)} ${bin.slice(6)}`)).toBeNull();
    expect(binProblem("")).toBe("Укажите БИН");
    expect(binProblem("12345")).toBe("БИН — 12 цифр");
    const wrong = `${bin.slice(0, 11)}${(Number(bin[11]) + 1) % 10}`;
    expect(binProblem(wrong)).toMatch(/контрольная цифра/);
  });

  it("takes a Kazakhstan mobile number in any spelling", () => {
    expect(mobilePhone("+7 705 777 12 34")).toBe("+77057771234");
    expect(mobilePhone("87057771234")).toBe("+77057771234");
    expect(mobilePhone("+7 727 111 22 33")).toBeNull();
  });

  it("says a taken БИН at its field with a link to the supplier who has it", () => {
    const id = "0b6c9f1e-2a3d-4c5b-8e7f-9a0b1c2d3e4f";
    expect(supplierErrorView(error(409, "SUPPLIER_BIN_TAKEN", { existingSupplierId: id }))).toEqual(
      {
        text: "Поставщик с этим БИН уже есть",
        field: "bin",
        link: { href: `/suppliers/${id}`, label: "Открыть" },
        currentVersion: null,
      },
    );
  });

  it("gives a colleague's change the version for «Обновить данные»", () => {
    const view = supplierErrorView(error(409, "SUPPLIER_VERSION_CONFLICT", { currentVersion: 7 }));
    expect(view.currentVersion).toBe(7);
    expect(view.text).toMatch(/Эти данные только что изменил/);
  });

  it("says the blocking (D-070), the funnel's and the states' refusals in words", () => {
    expect(supplierErrorView(error(403, "SUPPLIER_BLOCKED")).text).toMatch(
      /добавлять сотрудников и отправлять приглашения нельзя/,
    );
    expect(
      supplierErrorView(
        error(409, "SUPPLIER_LEAD_STATE", { status: "new", refusal: "contract_not_signed" }),
      ).text,
    ).toMatch(/Договор подписан/);
    expect(
      supplierErrorView(error(409, "SUPPLIER_STATE", { refusal: "already_blocked" })).text,
    ).toMatch(/уже заблокирована/);
    expect(
      supplierErrorView(error(409, "SUPPLIER_MEMBER_EXISTS", { memberId: "x", status: "removed" })),
    ).toMatchObject({ field: "phone", text: expect.stringMatching(/Восстановить доступ/) });
    expect(supplierErrorView(error(409, "SUPPLIER_LAST_MEMBER")).text).toMatch(/хотя бы один/);
  });

  it("says when an invitation may be sent again, in minutes or hours", () => {
    const soon = error(429, "RATE_LIMITED", {
      limit: "supplier_invitation_resend",
      retryAfterSeconds: 240,
    });
    expect(supplierErrorView(soon).text).toBe(
      "Приглашение этому сотруднику уже отправляли недавно. Повторно — через 4 мин",
    );
    const later = error(429, "RATE_LIMITED", {
      limit: "supplier_invitation_resend",
      retryAfterSeconds: 5 * 3600,
    });
    expect(waitText(later)).toBe("через 5 ч");
  });

  it("puts the server's field errors at their fields, in Russian", () => {
    const at = (path: string) =>
      supplierErrorView(error(400, "VALIDATION_ERROR", [{ path, message: "x" }]));
    expect(at("bin")).toMatchObject({ field: "bin", text: "Неверный БИН — проверьте цифры" });
    expect(at("firstMember.phone")).toMatchObject({ field: "firstMember.phone" });
    expect(at("firstMember.phone").text).toMatch(/казахстанский мобильный/);
    expect(at("closedDates.0.date")).toMatchObject({ field: "closedDates" });
    expect(at("contractSignedOn").text).toMatch(/позже сегодняшней/);
  });
});

describe("the words of «Прайс» of a supplier's card (TASK-046)", () => {
  const entry = (stats: PriceImport["stats"]) => ({ stats }) as PriceImport;

  it("say what is known of the rows so far", () => {
    expect(priceImportNumbers(entry(null))).toBe("—");
    expect(
      priceImportNumbers(
        entry({ rows: 1250, dataRows: 1240, serviceRows: 9, parsedRows: null, errorRows: null }),
      ),
    ).toBe(`с товарами: ${(1240).toLocaleString("ru-RU")}`);
    expect(
      priceImportNumbers(
        entry({ rows: 1250, dataRows: 1240, serviceRows: 9, parsedRows: 1228, errorRows: 12 }),
      ),
    ).toBe(`с товарами: ${(1240).toLocaleString("ru-RU")}, с ошибками: 12`);
  });

  it("name every state and every reason of a failure", () => {
    for (const status of ["parsing", "columns", "reading", "parsed", "failed"] as const) {
      expect(PRICE_IMPORT_STATUS_TEXT[status]).toBeTruthy();
    }
    expect(
      priceImportFailureText({ reason: "old_excel", detected: "xls", limit: null, line: null }),
    ).toBe("старый .xls");
  });
});

describe("the section's words on screen (TASK-080)", () => {
  it("reads «Название или БИН»: digits are a БИН, whole at 12", () => {
    expect(leadSearchOf("  ")).toEqual({});
    expect(leadSearchOf("Детали Юг")).toEqual({ q: "Детали Юг" });
    expect(leadSearchOf("0807 4000")).toEqual({ bin: "08074000", complete: false });
    expect(leadSearchOf("080740-000128")).toEqual({ bin: "080740000128", complete: true });
    expect(leadSearchOf("Юг 24")).toEqual({ q: "Юг 24" });
  });

  it("says the version of a consent text without codes (X28)", () => {
    expect(consentVersionText("2026-09-mvp")).toBe("версия текста от сент. 2026");
    expect(consentVersionText("2026-05")).toBe("версия текста от мая 2026");
    expect(consentVersionText("1")).toBe("версия текста 1");
    expect(consentVersionText("2026-13-x")).toBe("версия текста 2026-13-x");
  });

  it("hides an address the server could not shorten (X28)", () => {
    expect(ipText("0:0::*")).toBe("IP скрыт");
    expect(ipText(null)).toBe("IP скрыт");
    expect(ipText("203.0.113.*")).toBe("IP 203.0.113.*");
  });

  it("folds the sessions of one employee on one device in a row (X22)", () => {
    const session = (id: string, member: string, deviceName: string | null) => ({
      id,
      member: { id: member },
      deviceName,
      platform: "supplier-web",
      clientVersion: "0.1.0",
    });
    const groups = sessionGroups([
      session("1", "a", "Chrome · Windows"),
      session("2", "a", "Chrome · Windows"),
      session("3", "a", "Chrome · Windows"),
      session("4", "b", "Chrome · Windows"),
      session("5", "a", "Chrome · Windows"),
      session("6", "a", null),
    ]);
    expect(groups.map((group) => [group.first.id, group.rest.map((rest) => rest.id)])).toEqual([
      ["1", ["2", "3"]],
      ["4", []],
      ["5", []],
      ["6", []],
    ]);
  });

  it("names a file's type by its content", () => {
    expect(priceImportTypeText({ format: "xlsx", fileName: "price.xlsx" })).toBe("Excel");
    expect(priceImportTypeText({ format: "csv", fileName: "price.CSV" })).toBe("CSV");
    expect(priceImportTypeText({ format: "xlsx", fileName: "renamed.csv" })).toBe(
      "Excel по содержимому",
    );
    expect(priceImportTypeText({ format: "csv", fileName: null })).toBe("CSV");
  });

  it("counts the models of a service priced by model", () => {
    const model = (price: number) => ({
      make: { id: "m", name: "Geely" },
      model: { id: "x", name: "Atlas" },
      price,
      available: true,
    });
    const pricing = (count: number) =>
      ({
        mode: "by_model",
        models: Array.from({ length: count }, (_, index) => model(index)),
      }) as never;
    expect(offerPriceLine({ pricing: { mode: "single" } as never })).toBe("");
    expect(offerPriceLine({ pricing: pricing(1) })).toBe("1 модель");
    expect(offerPriceLine({ pricing: pricing(2) })).toBe("2 модели");
    expect(offerPriceLine({ pricing: pricing(5) })).toBe("5 моделей");
  });
});
