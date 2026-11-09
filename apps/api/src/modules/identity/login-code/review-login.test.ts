import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../../config";
import type { DatabaseService } from "../../../database";
import type { ActionJournal } from "../action-journal";
import { ReviewLogins } from "./review-login";

/**
 * What a constant code opens (TASK-077, TASK-055): the store review number —
 * the mobile app only, everywhere; a tester's — every client, never in
 * production. The database is not reached by any of this.
 */
function reviewLogins(nodeEnv: AppConfig["nodeEnv"]): ReviewLogins {
  return new ReviewLogins({ nodeEnv } as AppConfig, {} as DatabaseService, {} as ActionJournal);
}

describe("ReviewLogins.opens", () => {
  it("opens only the app with the store review number, in every environment", () => {
    for (const env of ["development", "test", "staging", "production"] as const) {
      expect(reviewLogins(env).opens("store_review", true)).toBe(true);
      expect(reviewLogins(env).opens("store_review", false)).toBe(false);
    }
  });

  it("opens every client with a tester's number outside production, none in production", () => {
    for (const env of ["development", "test", "staging"] as const) {
      expect(reviewLogins(env).opens("tester", true)).toBe(true);
      expect(reviewLogins(env).opens("tester", false)).toBe(true);
    }
    expect(reviewLogins("production").opens("tester", true)).toBe(false);
    expect(reviewLogins("production").opens("tester", false)).toBe(false);
  });

  it("refuses to enable a tester's number in production", async () => {
    await expect(
      reviewLogins("production").enable({
        phone: "+77070000171",
        code: "802461",
        validUntil: new Date(Date.now() + 86_400_000),
        reason: "tester",
        tester: true,
      }),
    ).rejects.toThrow(/staging and development/);
  });
});
