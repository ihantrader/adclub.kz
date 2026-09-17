import { DrizzleQueryError } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { withoutQueryParameters } from "./database-error";

describe("withoutQueryParameters", () => {
  it("drops the bound values of a failed query, keeping the SQL and the cause", () => {
    const cause = new Error("connect ECONNREFUSED 127.0.0.1:5432");
    const error = new DrizzleQueryError(
      'insert into "account" ("phone") values ($1)',
      ["+77011234567"],
      cause,
    );
    const safe = withoutQueryParameters(error) as Error;
    expect(safe.message).toBe(
      'Database query failed: connect ECONNREFUSED 127.0.0.1:5432; query: insert into "account" ("phone") values ($1)',
    );
    expect(`${safe.message}\n${safe.stack}`).not.toContain("7011234567");
    expect(safe.stack).toMatch(/^DatabaseQueryError: /);
    expect(safe.stack).toMatch(/\n\s+at /);
    expect(safe.cause).toBe(cause);
  });

  it("returns any other error as it is", () => {
    const error = new Error("boom");
    expect(withoutQueryParameters(error)).toBe(error);
    expect(withoutQueryParameters("text")).toBe("text");
  });
});
