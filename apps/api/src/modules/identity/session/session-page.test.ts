import { describe, expect, it } from "vitest";
import { ApiException } from "../../../common/errors";
import { sessionPage } from "./session-page";

const at = (minute: number) => new Date(Date.UTC(2026, 9, 16, 10, minute));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** 25 sessions, used one minute apart; two of them at the very same moment. */
const rows = Array.from({ length: 25 }, (_, index) => ({
  id: id(index + 1),
  lastUsedAt: at(index === 24 ? 23 : index),
  createdAt: at(0),
}));

describe("sessionPage (TASK-080, X22)", () => {
  it("without a limit gives every session, most recently used first", () => {
    const page = sessionPage(rows, {});
    expect(page.rows).toHaveLength(25);
    expect(page.nextCursor).toBeNull();
    expect(page.total).toBe(25);
    expect(page.rows[0]!.lastUsedAt.getTime()).toBeGreaterThanOrEqual(
      page.rows[1]!.lastUsedAt.getTime(),
    );
  });

  it("pages without gaps or repeats, ties broken by id", () => {
    const first = sessionPage(rows, { limit: 10 });
    expect(first.rows).toHaveLength(10);
    expect(first.total).toBe(25);
    expect(first.nextCursor).not.toBeNull();
    const rest = sessionPage(rows, { limit: 200, cursor: first.nextCursor! });
    expect(rest.rows).toHaveLength(15);
    expect(rest.nextCursor).toBeNull();
    const seen = [...first.rows, ...rest.rows].map((row) => row.id);
    expect(new Set(seen).size).toBe(25);
  });

  it("a session ended meanwhile does not shift the next page", () => {
    const first = sessionPage(rows, { limit: 10 });
    const shown = new Set(first.rows.map((row) => row.id));
    const fewer = rows.filter((row) => row.id !== first.rows[3]!.id);
    const rest = sessionPage(fewer, { limit: 200, cursor: first.nextCursor! });
    expect(rest.rows.some((row) => shown.has(row.id))).toBe(false);
    expect(rest.rows).toHaveLength(15);
  });

  it("refuses a cursor it did not issue", () => {
    expect(() => sessionPage(rows, { limit: 10, cursor: "not-a-cursor" })).toThrow(ApiException);
  });
});
