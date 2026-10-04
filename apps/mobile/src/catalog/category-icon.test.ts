import { describe, expect, it } from "vitest";
import { categoryIconOf } from "./category-icon";

const tree = [
  {
    id: "brakes",
    icon: "disc" as const,
    children: [
      { id: "pads", icon: null },
      { id: "calipers", icon: "tool" as const },
    ],
  },
  { id: "bare", icon: null, children: [{ id: "mats", icon: null }] },
];

describe("the icon of an item without a photo (DESIGN 7.8, TASK-030.A)", () => {
  it("is the subcategory's own, or its node's", () => {
    expect(categoryIconOf(tree, "calipers")).toBe("tool");
    expect(categoryIconOf(tree, "pads")).toBe("disc");
  });

  it("is the generic one when nobody gave one, or the tree is not there yet", () => {
    expect(categoryIconOf(tree, "mats")).toBeNull();
    expect(categoryIconOf(tree, "unknown")).toBeNull();
    expect(categoryIconOf(undefined, "pads")).toBeNull();
  });
});
