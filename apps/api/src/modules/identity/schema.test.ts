import { describe, expect, it } from "vitest";
import { getTableColumns, getTableName } from "drizzle-orm";
import { account } from "./schema";

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
