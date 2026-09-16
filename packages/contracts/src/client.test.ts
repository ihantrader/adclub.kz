import { describe, expect, it } from "vitest";
import { formatClientHeader, parseClientHeader, type ClientInfo } from "./client";

describe("X-Client header", () => {
  it.each<[ClientInfo, string]>([
    [{ platform: "ios", version: "1.4.2" }, "mobile/1.4.2 (ios)"],
    [{ platform: "android", version: "1.0.0" }, "mobile/1.0.0 (android)"],
    [{ platform: "admin-web", version: "0.1.0" }, "admin-web/0.1.0"],
    [{ platform: "supplier-web", version: "0.2.0" }, "supplier-web/0.2.0"],
  ])("round-trips %j", (client, header) => {
    expect(formatClientHeader(client)).toBe(header);
    expect(parseClientHeader(header)).toEqual(client);
  });

  it.each([
    undefined,
    null,
    "",
    "mobile/1.0.0",
    "mobile/1.0.0 (windows)",
    "admin-web/0.1.0 (ios)",
    "desktop/1.0.0",
    "curl/8.5.0",
    "admin-web/",
    `admin-web/${"9".repeat(80)}`,
  ])("treats %j as an unknown client", (value) => {
    expect(parseClientHeader(value)).toBeNull();
  });

  it("returns the version as sent; validating it is up to the caller", () => {
    expect(parseClientHeader("mobile/banana (android)")).toEqual({
      platform: "android",
      version: "banana",
    });
  });
});
