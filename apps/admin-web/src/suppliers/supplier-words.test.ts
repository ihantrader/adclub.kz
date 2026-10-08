import { ApiError, type ApiErrorCode } from "@adclub/api-client";
import { kzBinCheckDigit } from "@adclub/domain";
import { describe, expect, it } from "vitest";
import {
  binProblem,
  hiddenPhone,
  leadMoves,
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
