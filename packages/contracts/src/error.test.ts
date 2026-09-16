import { describe, expect, it } from "vitest";
import { apiErrorResponseSchema } from "./error";

describe("apiErrorResponseSchema", () => {
  it("accepts a well-formed error response", () => {
    const result = apiErrorResponseSchema.safeParse({
      code: "VALIDATION_ERROR",
      message: "Invalid request body",
      details: { fieldErrors: { phone: ["Required"] } },
      retryable: false,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a response without optional details", () => {
    const result = apiErrorResponseSchema.safeParse({
      code: "NOT_FOUND",
      message: "Route not found",
      retryable: false,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown error code", () => {
    const result = apiErrorResponseSchema.safeParse({
      code: "SOMETHING_ELSE",
      message: "oops",
      retryable: false,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a response missing retryable", () => {
    const result = apiErrorResponseSchema.safeParse({
      code: "INTERNAL_ERROR",
      message: "oops",
    });
    expect(result.success).toBe(false);
  });
});
