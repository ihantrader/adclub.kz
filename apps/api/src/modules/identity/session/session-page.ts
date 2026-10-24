import { ApiException } from "../../../common/errors";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encodeCursor(position: string, id: string): string {
  return Buffer.from(JSON.stringify([position, id]), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { position: string; id: string } {
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

/** A session as the administrator's lists order it. */
interface PagedSession {
  id: string;
  lastUsedAt: Date;
  createdAt: Date;
}

/** The order of the lists: most recently used first, then the newest, then by id. */
function key(row: PagedSession): [string, string, string] {
  return [row.lastUsedAt.toISOString(), row.createdAt.toISOString(), row.id];
}

function before(a: [string, string, string], b: [string, string, string]): boolean {
  for (let index = 0; index < 3; index++) {
    if (a[index]! !== b[index]!) return a[index]! > b[index]!;
  }
  return false;
}

/**
 * One page of a person's or a company's active sessions (TASK-080, X22):
 * an employee may have a hundred of them. The active sessions of one
 * account or company are few enough to read whole; the page is cut here,
 * after the position of the cursor (the last session read: its use, its
 * creation and its id), so a session ended meanwhile neither shifts the
 * next page nor repeats a row. Without `limit` — everything, as before.
 */
export function sessionPage<T extends PagedSession>(
  rows: readonly T[],
  query: { limit?: number; cursor?: string },
): { rows: T[]; nextCursor: string | null; total: number } {
  const ordered = [...rows].sort((a, b) =>
    before(key(a), key(b)) ? -1 : before(key(b), key(a)) ? 1 : 0,
  );
  let rest = ordered;
  if (query.cursor) {
    const { position, id } = decodeCursor(query.cursor);
    const [lastUsedAt, createdAt] = position.split("|");
    const after: [string, string, string] = [lastUsedAt ?? "", createdAt ?? "", id];
    rest = ordered.filter((row) => before(after, key(row)));
  }
  if (query.limit === undefined) return { rows: rest, nextCursor: null, total: ordered.length };
  const page = rest.slice(0, query.limit);
  const last = page[page.length - 1];
  const nextCursor =
    rest.length > query.limit && last
      ? encodeCursor(`${last.lastUsedAt.toISOString()}|${last.createdAt.toISOString()}`, last.id)
      : null;
  return { rows: page, nextCursor, total: ordered.length };
}
