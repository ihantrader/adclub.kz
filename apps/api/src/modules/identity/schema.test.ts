import { describe, expect, it } from "vitest";
import { getTableColumns, getTableName } from "drizzle-orm";
import { account, identityTables, otpChallenge, phoneVerification, session } from "./schema";

describe("identity schema: account", () => {
  it("maps to the account table created by the first migration", () => {
    expect(getTableName(account)).toBe("account");
  });

  it("exposes the columns ARCHITECTURE 5.1 defines for account", () => {
    const columns = Object.keys(getTableColumns(account));
    expect(columns.sort()).toEqual(
      [
        "id",
        "phone",
        "email",
        "status",
        "consentPhoneShareAt",
        "consentVersion",
        "createdAt",
        "updatedAt",
      ].sort(),
    );
  });
});

describe("identity schema: login codes", () => {
  it("maps to the tables created by the login code migration", () => {
    expect(getTableName(otpChallenge)).toBe("otp_challenge");
    expect(getTableName(phoneVerification)).toBe("phone_verification");
  });

  it("stores a code hash, never a code", () => {
    const columns = Object.keys(getTableColumns(otpChallenge));
    expect(columns).toContain("codeHash");
    expect(columns).not.toContain("code");
  });

  it("lists every identity table for the schema drift check", () => {
    expect(identityTables.map((table) => getTableName(table)).sort()).toEqual([
      "account",
      "otp_challenge",
      "phone_verification",
      "session",
    ]);
  });
});

describe("identity schema: sessions", () => {
  it("keeps no token, only what a token is derived from", () => {
    expect(getTableName(session)).toBe("session");
    const columns = Object.keys(getTableColumns(session));
    expect(columns).toContain("refreshSeed");
    expect(columns.filter((column) => /token|hash/i.test(column))).toEqual([]);
  });
});
