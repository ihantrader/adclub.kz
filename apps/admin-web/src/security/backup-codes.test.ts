import { describe, expect, it } from "vitest";
import { backupCodesFile } from "./backup-codes";

describe("the backup codes file", () => {
  it("holds every code on its own line and says they work once", () => {
    const text = backupCodesFile(["abcd-efgh", "ijkl-mnop"], new Date("2026-10-07T09:00:00Z"));
    const lines = text.split("\r\n");
    expect(lines).toContain("abcd-efgh");
    expect(lines).toContain("ijkl-mnop");
    expect(text).toContain("Каждый код действует один раз");
    expect(text).toContain("14:00");
  });
});
