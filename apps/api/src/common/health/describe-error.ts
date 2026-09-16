/**
 * Turns any thrown value into a non-empty, human-readable string.
 *
 * Plain `error.message` isn't enough: Node's "Happy Eyeballs" dual-stack
 * connection attempt (RFC 8305) throws an `AggregateError` with an empty
 * top-level `.message` when every address fails — e.g. connecting to a
 * stopped `localhost` Postgres container fails both the IPv4 and IPv6
 * attempts. On Linux (CI), `localhost` resolves to both and this path is
 * hit; on Windows (this machine, during development) it wasn't — found
 * because CI's readiness-reflects-outage test failed with an empty
 * `error` string while the identical local run passed (TASK-002.A).
 */
export function describeError(error: unknown): string {
  if (error instanceof AggregateError) {
    const inner = error.errors
      .map((cause) => describeError(cause))
      .filter((message) => message.length > 0)
      .join("; ");
    if (inner.length > 0) {
      return inner;
    }
  }

  if (error instanceof Error) {
    return error.message || error.name || "Unknown error";
  }

  const text = String(error);
  return text.length > 0 ? text : "Unknown error";
}
