import { describe, expect, it } from "vitest";
import { describeError } from "./describe-error";

describe("describeError", () => {
  it("returns a plain Error's message", () => {
    expect(describeError(new Error("connect ECONNREFUSED"))).toBe("connect ECONNREFUSED");
  });

  it("falls back to the error name when the message is empty", () => {
    const error = new Error("");
    expect(describeError(error)).toBe("Error");
  });

  it("joins the inner errors of an AggregateError with an empty top-level message", () => {
    // What Node's dual-stack ("Happy Eyeballs") connection attempt throws
    // when every address fails — this is the exact CI-only failure from
    // TASK-002.A (empty `error.message` on Linux, non-empty on Windows).
    const error = new AggregateError([
      new Error("connect ECONNREFUSED 127.0.0.1:5432"),
      new Error("connect ECONNREFUSED ::1:5432"),
    ]);
    expect(error.message).toBe("");

    expect(describeError(error)).toBe(
      "connect ECONNREFUSED 127.0.0.1:5432; connect ECONNREFUSED ::1:5432",
    );
  });

  it("never returns an empty string for an AggregateError with no inner errors", () => {
    const error = new AggregateError([]);
    expect(describeError(error)).toBeTruthy();
  });

  it("stringifies a non-Error thrown value", () => {
    expect(describeError("plain string failure")).toBe("plain string failure");
  });

  it("never returns an empty string for a falsy thrown value", () => {
    expect(describeError(undefined)).toBeTruthy();
    expect(describeError("")).toBeTruthy();
  });
});
