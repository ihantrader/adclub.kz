import type { Request } from "express";

/**
 * The value of cookie `name`, or `undefined` if it's absent or appears
 * more than once (ambiguous — possibly a cookie planted for a broader
 * path or parent domain; not guessed at).
 */
export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.cookie;
  if (typeof header !== "string") {
    return undefined;
  }
  const values: string[] = [];
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0 || pair.slice(0, separator).trim() !== name) {
      continue;
    }
    let value = pair.slice(separator + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    values.push(value);
  }
  return values.length === 1 && values[0] ? values[0] : undefined;
}
