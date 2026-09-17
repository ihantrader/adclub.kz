import { describe, expect, it } from "vitest";
import { verifyLoginCodeBodySchema } from "./login-code";
import { refreshSessionBodySchema, sessionIdPathSchema } from "./session";

describe("session request schemas", () => {
  it("accepts a refresh body with or without a token", () => {
    expect(refreshSessionBodySchema.safeParse({}).success).toBe(true);
    expect(refreshSessionBodySchema.safeParse({ refreshToken: "abc" }).success).toBe(true);
  });

  it.each([{ refreshToken: "" }, { refreshToken: "x".repeat(257) }, { refreshToken: 1 }])(
    "rejects a refresh body %j",
    (body) => {
      expect(refreshSessionBodySchema.safeParse(body).success).toBe(false);
    },
  );

  it("accepts only a UUID as a session id", () => {
    expect(
      sessionIdPathSchema.safeParse({ sessionId: "0b9b3f0e-7c1a-4b8e-9d42-1f0c2a3b4c5d" }).success,
    ).toBe(true);
    expect(sessionIdPathSchema.safeParse({ sessionId: "1 OR 1=1" }).success).toBe(false);
  });

  it("accepts an optional device name, trimmed, without control characters", () => {
    const base = { phone: "+77011234567", code: "123456" };
    expect(
      verifyLoginCodeBodySchema.parse({ ...base, deviceName: "  iPhone 15 " }).deviceName,
    ).toBe("iPhone 15");
    expect(verifyLoginCodeBodySchema.safeParse({ ...base, deviceName: "a\nb" }).success).toBe(
      false,
    );
    expect(verifyLoginCodeBodySchema.safeParse({ ...base, deviceName: " " }).success).toBe(false);
    expect(
      verifyLoginCodeBodySchema.safeParse({ ...base, deviceName: "x".repeat(65) }).success,
    ).toBe(false);
  });
});
