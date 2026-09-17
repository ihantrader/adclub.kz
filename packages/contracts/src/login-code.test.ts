import { describe, expect, it } from "vitest";
import { requestLoginCodeBodySchema, verifyLoginCodeBodySchema } from "./login-code";

describe("login code request bodies", () => {
  it("accepts the usual ways to write a phone number and an optional channel", () => {
    expect(requestLoginCodeBodySchema.safeParse({ phone: "+7 (701) 123-45-67" }).success).toBe(
      true,
    );
    expect(
      requestLoginCodeBodySchema.safeParse({ phone: "8 701 1234567", channel: "sms" }).success,
    ).toBe(true);
  });

  it.each([
    { phone: "" },
    { phone: "call me" },
    { phone: "1".repeat(33) },
    { phone: 77011234567 },
    { phone: "+77011234567", channel: "telegram" },
    {},
  ])("rejects %j", (body) => {
    expect(requestLoginCodeBodySchema.safeParse(body).success).toBe(false);
  });

  it.each([
    { phone: "+77011234567", code: "" },
    { phone: "+77011234567", code: "12a456" },
    { phone: "+77011234567", code: "1".repeat(17) },
    { phone: "+77011234567", code: 123456 },
    { phone: "+77011234567" },
  ])("rejects a verification body %j", (body) => {
    expect(verifyLoginCodeBodySchema.safeParse(body).success).toBe(false);
  });

  it("accepts a digits-only code", () => {
    expect(
      verifyLoginCodeBodySchema.safeParse({ phone: "+77011234567", code: "012345" }).success,
    ).toBe(true);
  });
});
