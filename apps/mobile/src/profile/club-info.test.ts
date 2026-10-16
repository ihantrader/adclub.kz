import { describe, expect, it } from "vitest";
import { documentsRows, partnerFormUrl } from "./club-info";

const empty = {
  termsUrl: null,
  privacyUrl: null,
  supportPhone: null,
  supportUrl: null,
  partnerFormUrl: null,
};

describe("«Документы и поддержка» and «Стать партнёром клуба» (TASK-077)", () => {
  it("shows only what the club has set: empty settings leave the consents alone", () => {
    expect(documentsRows(empty, true)).toEqual([{ kind: "consents" }]);
    expect(documentsRows(empty, false)).toEqual([]);
    expect(documentsRows(null, false)).toEqual([]);
    expect(
      documentsRows(
        {
          ...empty,
          termsUrl: "https://adclub.kz/terms",
          privacyUrl: "https://adclub.kz/privacy",
          supportPhone: "+77010000000",
        },
        false,
      ),
    ).toEqual([
      { kind: "terms", url: "https://adclub.kz/terms" },
      { kind: "privacy", url: "https://adclub.kz/privacy" },
      { kind: "contact", phone: "+77010000000", url: null },
    ]);
  });

  it("opens the club's partner page, and in development the cabinet next to the API", () => {
    expect(partnerFormUrl({ partnerFormUrl: "https://partners.adclub.kz/join" }, null)).toBe(
      "https://partners.adclub.kz/join",
    );
    expect(partnerFormUrl({ partnerFormUrl: null }, null)).toBeNull();
    expect(partnerFormUrl(null, { apiUrl: "http://192.168.1.10:3000" })).toBe(
      "http://192.168.1.10:5175/join",
    );
    expect(partnerFormUrl(null, { apiUrl: "https://api.adclub.kz" })).toBeNull();
  });
});
