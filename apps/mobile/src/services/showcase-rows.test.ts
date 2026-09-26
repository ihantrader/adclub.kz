import { describe, expect, it } from "vitest";
import { loadRows, type RowsPage } from "./showcase-rows";

interface Row {
  id: string;
}

const PAGE_MAX = 50;
const DEFAULT_SIZE = 20;

/** A server with `total` rows, paged by an offset cursor, and a log of what it was asked. */
function server(total: number) {
  const all: Row[] = Array.from({ length: total }, (_, index) => ({ id: `row-${index}` }));
  const asked: { cursor?: string; limit?: number }[] = [];
  const fetchPage = async (request: {
    cursor?: string;
    limit?: number;
  }): Promise<RowsPage & { total: number }> => {
    asked.push(request);
    const from = request.cursor ? Number(request.cursor) : 0;
    const size = request.limit ?? DEFAULT_SIZE;
    const items = all.slice(from, from + size);
    const end = from + items.length;
    return { items, nextCursor: end < total ? String(end) : null, total };
  };
  return { fetchPage, asked };
}

function options(fetchPage: ReturnType<typeof server>["fetchPage"], target: () => number) {
  return { fetchPage, target, pageMax: PAGE_MAX, defaultSize: DEFAULT_SIZE };
}

describe("reloading a list without shrinking it", () => {
  it("asks the server's own page for a list of one page or less", async () => {
    const { fetchPage, asked } = server(200);
    const rows = await loadRows(options(fetchPage, () => 0));
    expect(asked).toEqual([{}]);
    expect(rows.items).toHaveLength(DEFAULT_SIZE);
    expect(rows.cursor).toBe("20");

    const small = await loadRows(options(fetchPage, () => DEFAULT_SIZE));
    expect(small.items).toHaveLength(DEFAULT_SIZE);
  });

  it("asks for as many rows as the reader has when that fits one request", async () => {
    const { fetchPage, asked } = server(200);
    const rows = await loadRows(options(fetchPage, () => 40));
    expect(asked).toEqual([{ limit: 40 }]);
    expect(rows.items).toHaveLength(40);
    expect(rows.cursor).toBe("40");
  });

  it("rebuilds a list longer than the server's largest page by its cursor, in one result", async () => {
    const { fetchPage, asked } = server(200);
    const rows = await loadRows(options(fetchPage, () => 60));
    // The largest page first, then only what is still missing.
    expect(asked).toEqual([{ limit: 50 }, { cursor: "50", limit: 10 }]);
    expect(rows.items.map((row) => row.id)).toEqual(
      Array.from({ length: 60 }, (_, index) => `row-${index}`),
    );
    expect(rows.cursor).toBe("60");
  });

  it("goes on past several pages", async () => {
    const { fetchPage, asked } = server(500);
    const rows = await loadRows(options(fetchPage, () => 130));
    expect(asked.map((request) => request.limit)).toEqual([50, 50, 30]);
    expect(rows.items).toHaveLength(130);
  });

  it("does not shrink below what the reader had, and keeps what arrived while it was loading", async () => {
    const { fetchPage } = server(200);
    // A page landed on the screen while the reload was in flight: the reader
    // now has 60 rows, not the 40 the reload was started for.
    let wanted = 40;
    const rows = await loadRows(
      options(
        async (request) => {
          const page = await fetchPage(request);
          wanted = 60;
          return page;
        },
        () => wanted,
      ),
    );
    expect(rows.items).toHaveLength(60);
  });

  it("stops at the end of the list", async () => {
    const { fetchPage, asked } = server(45);
    const rows = await loadRows(options(fetchPage, () => 100));
    expect(rows.items).toHaveLength(45);
    expect(rows.cursor).toBeNull();
    // 45 rows: the first request asked for 50 and got them all.
    expect(asked).toEqual([{ limit: 50 }]);
  });

  it("never repeats a row a page returns again", async () => {
    const pages: RowsPage[] = [
      { items: [{ id: "a" }, { id: "b" }], nextCursor: "1" },
      { items: [{ id: "b" }, { id: "c" }], nextCursor: null },
    ];
    let index = 0;
    const rows = await loadRows({
      fetchPage: async () => pages[index++] ?? { items: [], nextCursor: null },
      target: () => 3,
      pageMax: PAGE_MAX,
      defaultSize: 1,
    });
    expect(rows.items.map((row) => row.id)).toEqual(["a", "b", "c"]);
  });

  it("stops asking when it is told to", async () => {
    const { fetchPage, asked } = server(500);
    const controller = new AbortController();
    const rows = await loadRows({
      ...options(
        async (request) => {
          controller.abort();
          return fetchPage(request);
        },
        () => 200,
      ),
      signal: controller.signal,
    });
    expect(asked).toHaveLength(1);
    expect(rows.items.length).toBeLessThan(200);
  });

  it("keeps the first page's answer for the category, the car and the totals", async () => {
    const { fetchPage } = server(200);
    const rows = await loadRows(options(fetchPage, () => 60));
    expect(rows.first.total).toBe(200);
    expect(rows.first.items).toHaveLength(50);
  });
});
