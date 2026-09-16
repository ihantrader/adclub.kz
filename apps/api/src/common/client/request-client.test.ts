import type { Request } from "express";
import { describe, expect, it } from "vitest";
import { describeRequestClient, getRequestClient, resolveClientHeader } from "./request-client";

describe("resolveClientHeader", () => {
  it("recognizes a well-formed client", () => {
    expect(resolveClientHeader("mobile/1.4.2 (android)")).toEqual({
      kind: "known",
      client: { platform: "android", version: "1.4.2" },
    });
  });

  it("reports a missing header", () => {
    expect(resolveClientHeader(undefined)).toEqual({ kind: "missing" });
    expect(resolveClientHeader("")).toEqual({ kind: "missing" });
  });

  it.each([
    "garbage",
    "mobile/1.4 (ios)",
    "mobile/banana (ios)",
    "admin-web/latest",
    "mobile/1.4.2 (symbian)",
    "x".repeat(10_000),
  ])("reports %j as invalid instead of throwing", (value) => {
    expect(resolveClientHeader(value)).toEqual({ kind: "invalid" });
  });

  it("treats a repeated header as invalid", () => {
    expect(resolveClientHeader(["admin-web/1.0.0", "admin-web/2.0.0"])).toEqual({
      kind: "invalid",
    });
  });
});

describe("getRequestClient", () => {
  it("reads the X-Client header case-insensitively via Node's lowercased headers", () => {
    const request = { headers: { "x-client": "supplier-web/0.3.0" } } as unknown as Request;
    expect(getRequestClient(request)).toEqual({
      kind: "known",
      client: { platform: "supplier-web", version: "0.3.0" },
    });
  });
});

describe("describeRequestClient", () => {
  it("never echoes an unparsed header", () => {
    expect(describeRequestClient({ kind: "invalid" })).toBe("invalid");
    expect(describeRequestClient({ kind: "missing" })).toBe("missing");
    expect(
      describeRequestClient({ kind: "known", client: { platform: "ios", version: "1.0.0" } }),
    ).toBe("mobile/1.0.0 (ios)");
  });
});
