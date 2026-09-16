import { describe, expect, it } from "vitest";
import { resolveApiUrl } from "./api-url";

describe("resolveApiUrl", () => {
  it("prefers an explicit URL", () => {
    expect(
      resolveApiUrl({
        explicitUrl: "https://api.adclub.kz/",
        devServerHostUri: "192.168.1.10:8081",
      }),
    ).toBe("https://api.adclub.kz");
  });

  it("targets the dev machine the phone already reaches over Wi-Fi", () => {
    expect(resolveApiUrl({ devServerHostUri: "192.168.1.10:8081" })).toBe(
      "http://192.168.1.10:3000",
    );
  });

  it("handles an Expo Go host URI with a path", () => {
    expect(resolveApiUrl({ devServerHostUri: "10.0.0.5:8081/--/" })).toBe("http://10.0.0.5:3000");
  });

  it("keeps an IPv6 host bracketed", () => {
    expect(resolveApiUrl({ devServerHostUri: "[fe80::1]:8081" })).toBe("http://[fe80::1]:3000");
  });

  it("ignores a blank explicit URL", () => {
    expect(resolveApiUrl({ explicitUrl: "  ", devServerHostUri: "192.168.0.2:8081" })).toBe(
      "http://192.168.0.2:3000",
    );
  });

  it("falls back to localhost", () => {
    expect(resolveApiUrl({})).toBe("http://localhost:3000");
    expect(resolveApiUrl({ devServerHostUri: null })).toBe("http://localhost:3000");
  });
});
