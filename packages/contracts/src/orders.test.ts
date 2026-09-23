import { describe, expect, it } from "vitest";
import {
  adminOrderListQuerySchema,
  adminOrderSchema,
  createOrderBodySchema,
  declineOrderBodySchema,
  ORDER_QUANTITY_LIMIT,
  supplierOrderSchema,
  supplierOrderSummarySchema,
  userOrderSchema,
  userOrderSummarySchema,
} from "./orders";

const base = {
  offerId: "5f3a1c52-7a4a-4f63-9a51-0a4f0c5a6b21",
  fulfillment: "pickup",
  expectedPrice: 6500,
  idempotencyKey: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed",
};

describe("the body of a new order", () => {
  it("takes one item by default and the flags off", () => {
    expect(createOrderBodySchema.parse(base)).toMatchObject({
      quantity: 1,
      allowAnotherActive: false,
    });
  });

  it.each([0, -1, 1.5, ORDER_QUANTITY_LIMIT + 1])("refuses the quantity %s", (quantity) => {
    expect(createOrderBodySchema.safeParse({ ...base, quantity }).success).toBe(false);
  });

  it("needs the price seen, the way to get it and a key", () => {
    for (const field of ["expectedPrice", "fulfillment", "idempotencyKey", "offerId"] as const) {
      const { [field]: _left, ...rest } = base;
      expect(createOrderBodySchema.safeParse(rest).success, field).toBe(false);
    }
    expect(createOrderBodySchema.safeParse({ ...base, fulfillment: "courier" }).success).toBe(
      false,
    );
  });

  it("takes a comment of several lines, not other control characters", () => {
    expect(
      createOrderBodySchema.parse({ ...base, comment: "  Позвоните\nпосле 18:00  " }).comment,
    ).toBe("Позвоните\nпосле 18:00");
    expect(createOrderBodySchema.safeParse({ ...base, comment: "a\u0007b" }).success).toBe(false);
    expect(createOrderBodySchema.safeParse({ ...base, comment: "   " }).success).toBe(false);
  });
});

describe("a decline", () => {
  it("has an optional reason and note", () => {
    expect(declineOrderBodySchema.parse({ expectedVersion: 1 })).toEqual({ expectedVersion: 1 });
    expect(
      declineOrderBodySchema.safeParse({ expectedVersion: 1, reason: "out_of_stock" }).success,
    ).toBe(true);
    expect(declineOrderBodySchema.safeParse({ expectedVersion: 1, reason: "late" }).success).toBe(
      false,
    );
  });
});

describe("the admin list", () => {
  it("leaves test orders out unless asked", () => {
    expect(adminOrderListQuerySchema.parse({}).test).toBe("exclude");
    expect(adminOrderListQuerySchema.parse({ number: "1042" }).number).toBe(1042);
  });
});

describe("what each side's schema can hold", () => {
  const keys = (schema: { shape: object }) => Object.keys(schema.shape);

  it("gives the code and the QR to the user's order only", () => {
    expect(keys(userOrderSchema)).toContain("confirmation");
    for (const schema of [
      userOrderSummarySchema,
      supplierOrderSchema,
      supplierOrderSummarySchema,
      adminOrderSchema,
    ]) {
      expect(keys(schema)).not.toContain("confirmation");
      expect(JSON.stringify(keys(schema))).not.toMatch(/code|qr/i);
    }
  });

  it("names no employee and no decline reason to the user", () => {
    expect(keys(userOrderSchema)).not.toContain("handledBy");
    expect(keys(userOrderSchema)).not.toContain("events");
    expect(keys(userOrderSchema)).not.toContain("decline");
    expect(keys(supplierOrderSchema)).toEqual(expect.arrayContaining(["handledBy", "events"]));
  });

  it("keeps the customer out of the supplier's list", () => {
    expect(keys(supplierOrderSummarySchema)).not.toContain("customer");
    expect(keys(supplierOrderSchema)).toContain("customer");
  });
});
