import { describe, expect, it } from "vitest";
import { latestConsents, outdatedConsents, type ConsentVersions } from "./consents";
import { deletedPhoneOf, isDeletedPhone } from "./deleted-account";
import { hidePhone, maskPhone } from "../phone/kz-mobile-phone";

const current: ConsentVersions = {
  phone_share: "2026-09-mvp",
  terms: "2026-11-mvp",
  vehicle_document: "2026-11-mvp",
};

describe("consents", () => {
  it("takes the last consent of each kind", () => {
    const latest = latestConsents([
      { kind: "terms", version: "a", at: "2026-01-01T00:00:00Z" },
      { kind: "terms", version: "b", at: "2026-02-01T00:00:00Z" },
      { kind: "phone_share", version: "x", at: new Date("2026-01-05T00:00:00Z") },
    ]);
    expect(latest.terms?.version).toBe("b");
    expect(latest.phone_share?.version).toBe("x");
    expect(latest.vehicle_document).toBeUndefined();
  });

  it("asks again for a consent never given or given for another version", () => {
    expect(outdatedConsents([], current, { storesVehicleDocument: false })).toEqual([
      "phone_share",
      "terms",
    ]);
    const given = [
      { kind: "phone_share" as const, version: "2026-09-mvp", at: "2026-10-01T00:00:00Z" },
      { kind: "terms" as const, version: "2026-10-old", at: "2026-10-01T00:00:00Z" },
    ];
    expect(outdatedConsents(given, current, { storesVehicleDocument: false })).toEqual(["terms"]);
  });

  it("asks about the vehicle document only of an account that keeps a VIN or a plate", () => {
    const given = [
      { kind: "phone_share" as const, version: "2026-09-mvp", at: "2026-10-01T00:00:00Z" },
      { kind: "terms" as const, version: "2026-11-mvp", at: "2026-10-01T00:00:00Z" },
    ];
    expect(outdatedConsents(given, current, { storesVehicleDocument: false })).toEqual([]);
    expect(outdatedConsents(given, current, { storesVehicleDocument: true })).toEqual([
      "vehicle_document",
    ]);
    expect(
      outdatedConsents(
        [
          ...given,
          { kind: "vehicle_document", version: "2026-11-mvp", at: "2026-10-02T00:00:00Z" },
        ],
        current,
        { storesVehicleDocument: true },
      ),
    ).toEqual([]);
  });
});

describe("the phone of a deleted account", () => {
  it("is letters only, so no masking shows a part of it as a number", () => {
    const phone = deletedPhoneOf("0123456789abcdef");
    expect(phone).toBe("deleted:abcdefghijklmnop");
    expect(isDeletedPhone(phone)).toBe(true);
    expect(isDeletedPhone("+77011234567")).toBe(false);
    expect(hidePhone(phone)).toBe("***");
    expect(maskPhone(phone)).toBe("***");
    expect(/\d/.test(phone)).toBe(false);
  });

  it("refuses what is not a hexadecimal digest", () => {
    expect(() => deletedPhoneOf("+77011234567")).toThrow();
  });
});
