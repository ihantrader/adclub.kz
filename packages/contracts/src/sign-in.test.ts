import { describe, expect, it } from "vitest";
import { switchSupplierBodySchema } from "./access";
import { verifyLoginCodeBodySchema } from "./login-code";
import {
  selectSupplierBodySchema,
  totpSetupConfirmBodySchema,
  totpVerifyBodySchema,
} from "./sign-in";

const SUPPLIER = "0b9b3f0e-7c1a-4b8e-9d42-1f0c2a3b4c5d";

describe("sign-in step bodies", () => {
  it("takes an optional preferred company at code verification", () => {
    const base = { phone: "+77011234567", code: "123456" };
    expect(verifyLoginCodeBodySchema.safeParse({ ...base, supplierId: SUPPLIER }).success).toBe(
      true,
    );
    expect(verifyLoginCodeBodySchema.safeParse({ ...base, supplierId: "acme" }).success).toBe(
      false,
    );
  });

  it("accepts a company choice only as a UUID with a step token", () => {
    expect(
      selectSupplierBodySchema.safeParse({ signInStep: "st1.x", supplierId: SUPPLIER }).success,
    ).toBe(true);
    expect(
      selectSupplierBodySchema.safeParse({ signInStep: "", supplierId: SUPPLIER }).success,
    ).toBe(false);
    expect(
      selectSupplierBodySchema.safeParse({ signInStep: "st1.x", supplierId: "1 OR 1=1" }).success,
    ).toBe(false);
    expect(switchSupplierBodySchema.safeParse({ supplierId: SUPPLIER }).success).toBe(true);
    expect(switchSupplierBodySchema.safeParse({}).success).toBe(false);
  });

  it("accepts a six-digit authenticator code only", () => {
    const step = { signInStep: "st1.x" };
    expect(totpSetupConfirmBodySchema.safeParse({ ...step, totpCode: "012345" }).success).toBe(
      true,
    );
    for (const totpCode of ["12345", "1234567", "12345a", " 123456"]) {
      expect(totpSetupConfirmBodySchema.safeParse({ ...step, totpCode }).success).toBe(false);
    }
  });

  it("wants exactly one of the authenticator code and a backup code", () => {
    const step = { signInStep: "st1.x" };
    expect(totpVerifyBodySchema.safeParse({ ...step, totpCode: "123456" }).success).toBe(true);
    expect(totpVerifyBodySchema.safeParse({ ...step, backupCode: "abcd-2345" }).success).toBe(true);
    expect(totpVerifyBodySchema.safeParse(step).success).toBe(false);
    expect(
      totpVerifyBodySchema.safeParse({ ...step, totpCode: "123456", backupCode: "abcd-2345" })
        .success,
    ).toBe(false);
    expect(totpVerifyBodySchema.safeParse({ ...step, backupCode: "abcd;drop" }).success).toBe(
      false,
    );
  });
});
