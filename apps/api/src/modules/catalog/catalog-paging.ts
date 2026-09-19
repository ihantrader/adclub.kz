import { ApiException } from "../../common/errors";

/**
 * Keyset paging of the catalog's admin lists (ARCHITECTURE 4.17): a cursor
 * is the position of the last row read (its sort key) and its id, so rows
 * added or changed while reading neither repeat nor go missing — the same
 * scheme as the action journal (4.13, 4.14 I134).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCursor(position: string, id: string): string {
  return Buffer.from(JSON.stringify([position, id]), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): { position: string; id: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    parsed = undefined;
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== "string" ||
    typeof parsed[1] !== "string" ||
    !UUID.test(parsed[1])
  ) {
    throw new ApiException(400, "VALIDATION_ERROR", "The paging cursor is not one we issued", {
      details: [{ path: "cursor", message: "Use the nextCursor of the previous page" }],
    });
  }
  return { position: parsed[0], id: parsed[1] };
}

/** A time position at the database's precision (microseconds), as the cursor keeps it. */
export const TIME_POSITION = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** The PostgreSQL error behind a failed query, if it broke this unique constraint. */
/** How many times a change refused by a unique key whose clashing row is gone is tried. */
export const UNIQUE_RACE_ATTEMPTS = 2;

export function uniqueViolation(error: unknown, constraint: string): boolean {
  for (let current: unknown = error; current; current = (current as { cause?: unknown }).cause) {
    const candidate = current as { code?: unknown; constraint?: unknown };
    if (candidate.code === "23505" && candidate.constraint === constraint) {
      return true;
    }
    if (current === (current as { cause?: unknown }).cause) {
      break;
    }
  }
  return false;
}

/** `text` as a literal part of a `LIKE` pattern (with `ESCAPE '\'`). */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (character) => `\\${character}`);
}
