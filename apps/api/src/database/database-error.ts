import { DrizzleQueryError } from "drizzle-orm";
import { describeError } from "../common/health/describe-error";

/** SQLSTATE of a foreign-key violation. */
export const FOREIGN_KEY_VIOLATION = "23503";

/**
 * The driver's own error (`pg`'s: `code`, `constraint`) behind a failed
 * query, however many wrappers buried it: Drizzle throws `DrizzleQueryError`
 * with it only on `.cause`, and `withoutQueryParameters` wraps even that a
 * level further for the log. A check of `error.code` alone sees neither
 * (found live, TASK-029: a non-existent `cityId` or vehicle id answered 500
 * instead of 400). Walks the whole `cause` chain, without looping on a
 * self-referencing one.
 */
export function postgresError(error: unknown): { code: string; constraint?: string } | undefined {
  const seen = new Set<unknown>();
  for (let current = error; typeof current === "object" && current !== null;) {
    if (seen.has(current)) {
      return undefined;
    }
    seen.add(current);
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (typeof candidate.code === "string") {
      return {
        code: candidate.code,
        ...(typeof candidate.constraint === "string" ? { constraint: candidate.constraint } : {}),
      };
    }
    current = candidate.cause;
  }
  return undefined;
}

/**
 * A failed query's error without its parameters. Drizzle puts the bound
 * values into the message (`params: …`), and those can be a phone number
 * or other personal data; the SQL text itself is parameterized and safe.
 * Other errors are returned unchanged.
 */
export function withoutQueryParameters(error: unknown): unknown {
  if (!(error instanceof DrizzleQueryError)) {
    return error;
  }
  const safe = new Error(
    `Database query failed: ${describeError(error.cause)}; query: ${error.query}`,
    { cause: error.cause },
  );
  safe.name = "DatabaseQueryError";
  const frames = (error.stack ?? "").split("\n").filter((line) => /^\s+at /.test(line));
  safe.stack = [`${safe.name}: ${safe.message}`, ...frames].join("\n");
  return safe;
}
