import { describe, expect, it } from "vitest";
import { tileRows } from "./tile-rows";

describe("tiles of the catalog's main screen (TASK-030.A)", () => {
  it("puts the first node of the data alone in a wide row, the rest two to a row", () => {
    expect(tileRows(["a", "b", "c", "d", "e"])).toEqual([["a"], ["b", "c"], ["d", "e"]]);
  });

  it("keeps half the width for a last odd tile", () => {
    expect(tileRows(["a", "b", "c", "d"])).toEqual([["a"], ["b", "c"], ["d", null]]);
  });

  it("follows the order of the data, whatever node comes first", () => {
    expect(tileRows(["consumables", "engine"])[0]).toEqual(["consumables"]);
    expect(tileRows(["engine", "consumables"])[0]).toEqual(["engine"]);
  });

  it("has no rows without nodes, and one wide row for a single node", () => {
    expect(tileRows([])).toEqual([]);
    expect(tileRows(["a"])).toEqual([["a"]]);
  });
});
