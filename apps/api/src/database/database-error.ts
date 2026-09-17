import { DrizzleQueryError } from "drizzle-orm";
import { describeError } from "../common/health/describe-error";

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
