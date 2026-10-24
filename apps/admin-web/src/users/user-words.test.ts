import { ApiError } from "@adclub/api-client";
import { describe, expect, it } from "vitest";
import {
  accessMark,
  consentText,
  consentVersionText,
  ipText,
  accessText,
  carDocumentText,
  carText,
  deviceText,
  endOfYear,
  grantUntil,
  userErrorText,
  userFiltersOf,
} from "./user-words";

describe("the words of «Пользователи» (TASK-036.B)", () => {
  it("says club access in place of the subscription", () => {
    expect(
      accessText({ granted: true, source: "manual", validUntil: "2026-12-31T18:59:59.000Z" }),
    ).toBe("до 31.12.2026");
    expect(accessText({ granted: false, source: null, validUntil: null })).toBe("нет");
    // The operator command ends a grant at the start of the next day of Almaty: the last day shown.
    expect(
      accessText({ granted: true, source: "manual", validUntil: "2026-12-31T19:00:00.000Z" }),
    ).toBe("до 31.12.2026");
  });

  it("gives a grant until the end of the chosen day of Almaty, by default the year's end", () => {
    expect(grantUntil("2026-12-31")).toBe("2026-12-31T18:59:59.000Z");
    expect(grantUntil("31.12.2026")).toBeNull();
    expect(endOfYear(new Date("2026-10-10T10:00:00Z"))).toBe("2026-12-31");
    // The last hours of the year in Almaty are already the next year.
    expect(endOfYear(new Date("2026-12-31T20:00:00Z"))).toBe("2027-12-31");
  });

  it("keeps the filters in the address and «истекает в N дней» in its bounds", () => {
    expect(
      userFiltersOf(new URLSearchParams("q=4567&clubAccess=expiring&expiringDays=14&noShows=true")),
    ).toEqual({
      q: "4567",
      clubAccess: "expiring",
      expiringDays: 14,
      noShows: "true",
      unconfirmedCar: undefined,
    });
    expect(userFiltersOf(new URLSearchParams("clubAccess=x&expiringDays=900"))).toEqual({
      q: undefined,
      clubAccess: undefined,
      expiringDays: 7,
      noShows: undefined,
      unconfirmedCar: undefined,
    });
    // TASK-057: «Есть автомобиль без подтверждённого документа».
    expect(userFiltersOf(new URLSearchParams("unconfirmedCar=true")).unconfirmedCar).toBe("true");
  });

  it("says the mark of a car's document, never «владение подтверждено» (TASK-057)", () => {
    const day = (iso: string) => iso.slice(0, 10);
    expect(carDocumentText({ status: "shown", at: "2026-10-10T08:00:00.000Z" }, day)).toBe(
      "Документ показан · 2026-10-10",
    );
    expect(carDocumentText({ status: "unconfirmed", at: "2026-10-10T08:00:00.000Z" }, day)).toBe(
      "Документ не подтверждён · 2026-10-10",
    );
    expect(carDocumentText(null, day)).toBe("Без отметки о документе");
  });

  it("names a device, a car and a refusal in words", () => {
    expect(deviceText({ deviceName: "iPhone 15", platform: "ios", clientVersion: "1.4.2" })).toBe(
      "iPhone 15 · iPhone · версия 1.4.2",
    );
    expect(deviceText({ deviceName: null, platform: null, clientVersion: null })).toBe(
      "Устройство не назвалось",
    );
    expect(
      carText({
        id: "00000000-0000-4000-8000-000000000001",
        make: { id: "00000000-0000-4000-8000-000000000002", label: "Geely" },
        model: { id: "00000000-0000-4000-8000-000000000003", label: "Atlas" },
        year: 2023,
        generation: { id: "00000000-0000-4000-8000-000000000004", label: "II (FX11)" },
        body: null,
        engine: null,
        transmission: null,
        drive: null,
        modificationId: null,
        color: null,
        vin: null,
        plate: null,
        document: null,
        isPrimary: true,
        createdAt: "2026-10-10T10:00:00.000Z",
        updatedAt: "2026-10-10T10:00:00.000Z",
      }),
    ).toBe("Geely Atlas 2023 · II (FX11)");
    expect(
      userErrorText(
        new ApiError({
          status: 409,
          code: "CLUB_ACCESS_NOT_GRANTED",
          message: "nothing",
          retryable: false,
        }),
      ),
    ).toMatch(/Отзывать нечего/);
  });
});

describe("the view of «Пользователи» (TASK-080)", () => {
  const now = new Date("2026-10-24T12:00:00+05:00");

  it("marks club access: until, ending within a week, none", () => {
    expect(
      accessMark(
        { granted: true, source: "subscription", validUntil: "2026-11-17T18:59:59.000Z" },
        now,
      ),
    ).toEqual({ tone: "success", icon: "circleCheck", text: "До 17.11 · подписка" });
    expect(
      accessMark({ granted: true, source: "manual", validUntil: "2026-10-27T18:59:59.000Z" }, now),
    ).toEqual({ tone: "warning", icon: "clock", text: "Истекает 27.10" });
    expect(
      accessMark({ granted: true, source: "manual", validUntil: "2027-01-31T18:59:59.000Z" }, now)
        .text,
    ).toBe("До 31.01.2027");
    expect(accessMark({ granted: false, source: null, validUntil: null }, now)).toEqual({
      tone: "neutral",
      icon: "minus",
      text: "Нет",
    });
  });

  it("says a consent and a network in words, never their codes", () => {
    expect(consentVersionText("2026-09-mvp")).toBe("сент. 2026");
    expect(consentVersionText("v3")).toBe("v3");
    expect(
      consentText(
        { at: "2026-10-16T04:38:00.000Z", version: "2026-09-mvp" },
        () => "16 окт., 09:38",
      ),
    ).toBe("дано 16 окт., версия сент. 2026");
    expect(ipText("0:0::*")).toBe("IP скрыт");
    expect(ipText(null)).toBe("IP скрыт");
    expect(ipText("127.0.0.*")).toBe("IP скрыт");
    expect(ipText("203.0.113.*")).toBe("203.0.113.*");
  });
});
